import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { unzipSync } from 'fflate';
import Stripe from 'stripe';
import { defaultConfiguration, quoteProduct, seedCatalogue } from '../src/domain/catalogue';
import { defaultDesign } from '../src/domain/design';
import type { Account } from '../src/server/auth';
import { database, type Database } from '../src/server/db';
import { accountingCsv, productionFile, reports } from '../src/server/operations';
import { createOrder, decideProof, getProduct, listOrders, orderDetails, publishProof, readOrder, reorder, reviseQuote, staffTransition } from '../src/server/orders';
import { applySettlement, checkout, payInDemo, stripeEvent } from '../src/server/payments';
import { readObject, writeObject } from '../src/server/storage';
import { runGeneration } from '../src/server/worker';

const directory = mkdtempSync(path.join(tmpdir(), 'dh-workflow-'));
process.env.DH_DATA_DIR = directory;
process.env.APP_MODE = 'demo';
delete process.env.VERCEL;
after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));

const race = seedCatalogue.find((item) => item.id === 'race')!;
const { basePriceMinor, taxBps, ...raceSpecs } = race;
const originalCatalogue = { ...raceSpecs, basePence: basePriceMinor, vatBps: taxBps };
const config = defaultConfiguration(race);
const users = ['customer', 'customer', 'staff'].map((role, number): Account => ({
  id: randomUUID(), role: role as Account['role'], disabled: false, email: `test-${number}@example.com`, display_name: `Test ${number}`,
}));
const [buyer, stranger, staff] = users;
const csv = 'name,number\nMaya Patel,007\nRavi Shah,042\nAlexandra Fernanda Rodrigues,108';
const draft = { design: defaultDesign(race), csv, mapping: { name: 'name', number: 'number' } };

async function raceQuote() {
  const product = await getProduct(await database(), race.id);
  const { currency, total } = quoteProduct(product, config);
  return { configuration: config, currency, total, productRevision: product.revision };
}

async function place() {
  return createOrder(buyer, { ...await raceQuote(), key: randomUUID() });
}

async function current(db: Database, id: string) { return readOrder(db, buyer, id); }
async function publishAndApprove(db: Database, id: string) {
  const proof = await publishProof(buyer, id, { ...draft, revision: (await current(db, id)).revision });
  await decideProof(buyer, id, { proofId: proof.id, revision: (await current(db, id)).revision });
  return proof;
}

before(async () => {
  const legacyDatabase = await PGlite.create(path.join(directory, 'postgres'));
  try {
    await legacyDatabase.exec(await readFile('supabase/migrations/0001_printshop.sql', 'utf8'));
    await legacyDatabase.query('insert into printshop.catalogue (id,definition) values($1,$2)', [race.id, JSON.stringify(originalCatalogue)]);
  } finally { await legacyDatabase.close(); }
  const db = await database();
  for (const user of users) {
    await db.query('insert into printshop.accounts (id,email,display_name,role) values($1,$2,$3,$4)',
      [user.id, user.email, user.display_name, user.role]);
  }
});

test('race proof, INR payment replay, superseded checkout, interrupted render, archive and reorder', { timeout: 90000 }, async () => {
  const db = await database();
  const quote = await raceQuote();
  assert.deepEqual(await getProduct(db, race.id), { ...race, revision: race.revision + 1 });
  await assert.rejects(() => createOrder(buyer, { ...quote, key: randomUUID(), total: 1 }), /quote has changed/);
  await assert.rejects(() => createOrder(buyer, { ...quote, key: randomUUID(), currency: 'GBP' }), /quote has changed to ₹7\.20/);
  const order = await place();
  await assert.rejects(() => readOrder(db, stranger, order.id), /not found/);
  await assert.rejects(() => checkout(buyer, order.id), /Approve/);
  await assert.rejects(() => staffTransition(staff, order.id, 'start'), /not ready/);
  const v1 = await publishProof(buyer, order.id, { ...draft, revision: order.revision });
  const afterPublish = await current(db, order.id);
  await decideProof(buyer, order.id, { proofId: v1.id, revision: afterPublish.revision, comment: 'Please revise the headline.' });
  const revised = await publishProof(staff, order.id, { ...draft, revision: (await current(db, order.id)).revision });
  assert.equal(revised.version, 2);
  await assert.rejects(() => decideProof(buyer, order.id, { proofId: v1.id, revision: afterPublish.revision }), /changed/);
  await decideProof(buyer, order.id, { proofId: revised.id, revision: (await current(db, order.id)).revision });
  const attempt = await checkout(buyer, order.id);
  assert.equal(attempt.demo, true);
  if (!attempt.demo) throw new Error('Expected demo checkout');
  assert.equal((await checkout(buyer, order.id) as typeof attempt).attemptId, attempt.attemptId);
  await assert.rejects(() => productionFile(staff, order.id, 1, 'pdf'), /locked/);
  assert.deepEqual((await Promise.all([payInDemo(buyer, order.id, attempt.attemptId), payInDemo(buyer, order.id, attempt.attemptId)])).sort(),
    ['applied', 'duplicate']);
  const pending = (await orderDetails(staff, order.id)).job!;
  const staleToken = randomUUID();
  await db.query("update printshop.jobs set status='running', lease_token=$2, lease_until=now()-interval '1 minute', attempts=1,processed_rows=1 where id=$1",
    [pending.id, staleToken]);
  await writeObject(`DH${order.number}/race/v2/${staleToken}/partial.png`, Buffer.from('incomplete'), 'image/png');
  await assert.rejects(() => productionFile(staff, order.id, 1, 'pdf'), /locked/);
  assert.equal(await runGeneration(), true);
  assert.equal(await runGeneration(), false);
  const detail = await orderDetails(staff, order.id);
  assert.equal(detail.payments.length, 1);
  assert.equal(detail.payments[0].currency, 'INR');
  assert.equal(detail.payments[0].amount, 720);
  assert.equal(detail.job?.processed_rows, 3);
  assert.equal(detail.job?.attempts, 2);
  assert.equal(detail.files.filter(({ format }) => format !== 'zip').length, 6);
  assert.equal(detail.proofs[0].approver, buyer.display_name);
  const zip = await productionFile(staff, order.id, 0, 'zip');
  assert.equal(Object.keys(unzipSync(await readObject(zip.object_key))).length, 6);
  await assert.rejects(() => productionFile(buyer, order.id, 1, 'pdf'), /Staff access/);
  await assert.rejects(() => publishProof(buyer, order.id, { ...draft, revision: detail.order.revision }), /locked/);
  await staffTransition(staff, order.id, 'start');
  await staffTransition(staff, order.id, 'complete');
  assert.equal((await current(db, order.id)).stage, 'completed');
  const [raceReport] = await reports();
  assert.deepEqual(raceReport, { family: 'race', currency: 'INR', orders: 1, revenue: 720, completed: 1, units: 3 });
  assert.match(await accountingCsv(), new RegExp(`"DH${order.number}","[^\\n]+","7\\.20","INR",`));
  const repeat = await reorder(buyer, order.id, randomUUID());
  const repeated = await orderDetails(buyer, repeat.id);
  assert.equal(repeated.order.proof_state, 'approved');
  assert.equal(repeated.proofs[0].carried_from, revised.id);
  assert.equal(repeated.order.paid_at, null);

  const obsolete = await place();
  const old = await publishAndApprove(db, obsolete.id);
  const oldAttempt = await checkout(buyer, obsolete.id);
  if (!oldAttempt.demo) throw new Error('Expected demo checkout');
  await publishAndApprove(db, obsolete.id);
  assert.equal(await applySettlement({
    provider: 'demo', eventId: 'test-obsolete-event', orderId: obsolete.id, proofId: old.id, attemptId: oldAttempt.attemptId,
    session: `local_${oldAttempt.attemptId}`, reference: 'test-obsolete-ref', amount: 720, currency: 'INR', paidAt: new Date(),
  }), 'review');
  const review = await orderDetails(staff, obsolete.id);
  assert.equal(review.order.payment_review, true);
  assert.equal(review.job, undefined);
  assert.equal(review.unlocked, false);

  const signedOrder = await place();
  const signedProof = await publishAndApprove(db, signedOrder.id);
  const signedAttempt = randomUUID();
  await db.query(`insert into printshop.checkout_attempts (id,order_id,proof_id,provider,provider_session,expected_amount,currency)
    values($1,$2,$3,'stripe','cs_test_fixture',720,'INR')`, [signedAttempt, signedOrder.id, signedProof.id]);
  const payload = JSON.stringify({ id: 'evt_signed_fixture', type: 'checkout.session.completed', livemode: false,
    created: Math.floor(Date.now() / 1000), data: { object: {
      id: 'cs_test_fixture', mode: 'payment', payment_status: 'paid', currency: 'inr', amount_total: 720,
      payment_intent: 'pi_signed_fixture', metadata: { dh_attempt: signedAttempt, dh_order: signedOrder.id, dh_proof: signedProof.id },
    } },
  });
  process.env.APP_MODE = 'hosted';
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_local_fixture';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_fixture';
  try {
    const stripe = new Stripe(process.env.STRIPE_TEST_SECRET_KEY);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    await assert.rejects(() => stripeEvent(payload, 'invalid'), /Invalid webhook signature/);
    assert.equal(await stripeEvent(payload, header), 'applied');
    assert.equal(await stripeEvent(payload, header), 'duplicate');
  } finally {
    process.env.APP_MODE = 'demo';
    delete process.env.STRIPE_TEST_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
  assert.equal((await orderDetails(staff, signedOrder.id)).job?.status, 'queued');
});

test('keeps GBP payment records separate and requires an INR quote for old unpaid orders', async () => {
  const db = await database();
  const { basePriceMinor, taxBps, ...price } = quoteProduct(race, config);
  const legacyPrice = { ...price, currency: 'GBP', basePence: basePriceMinor, vatBps: taxBps };
  async function approvedLegacyOrder() {
    const order = await place();
    await db.query('update printshop.orders set price=$2, product_snapshot=$3 where id=$1',
      [order.id, JSON.stringify(legacyPrice), JSON.stringify(originalCatalogue)]);
    return { order, proof: await publishAndApprove(db, order.id) };
  }

  const { order: oldPaid, proof } = await approvedLegacyOrder();
  const priorAttempt = randomUUID();
  await db.query(`insert into printshop.checkout_attempts (id,order_id,proof_id,provider,provider_session,expected_amount,currency)
    values($1,$2,$3,'demo','legacy-session',720,'GBP')`, [priorAttempt, oldPaid.id, proof.id]);
  await assert.rejects(() => checkout(buyer, oldPaid.id), /Accept an INR quote/);
  await assert.rejects(() => payInDemo(buyer, oldPaid.id, priorAttempt), /Accept an INR quote/);
  assert.equal(await applySettlement({
    provider: 'demo', eventId: 'legacy-confirmation', attemptId: priorAttempt, orderId: oldPaid.id, proofId: proof.id,
    session: 'legacy-session', reference: 'legacy-payment', amount: 720, currency: 'GBP', paidAt: new Date(),
  }), 'applied');
  assert.equal((await current(db, oldPaid.id)).price.currency, 'GBP');
  assert.equal((await listOrders(buyer, {})).find(({ id }) => id === oldPaid.id)?.currency, 'GBP');
  assert.equal((await reports()).find(({ currency }) => currency === 'GBP')?.revenue, 720);
  assert.match(await accountingCsv(), /"7\.20","GBP","legacy-payment"/);

  const { order: unpaid } = await approvedLegacyOrder();
  await reviseQuote(buyer, unpaid.id, { ...await raceQuote(), revision: (await current(db, unpaid.id)).revision });
  const updated = await current(db, unpaid.id);
  assert.equal(updated.price.currency, 'INR');
  assert.equal(updated.proof_state, 'draft');
  await assert.rejects(() => checkout(buyer, unpaid.id), /Approve the current proof/);
  await publishAndApprove(db, unpaid.id);
  assert.equal((await checkout(buyer, unpaid.id)).demo, true);
});
