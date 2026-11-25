import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { unzipSync } from 'fflate';
import Stripe from 'stripe';
import { defaultConfiguration, quoteProduct, seedCatalogue } from '../src/domain/catalogue';
import { defaultDesign } from '../src/domain/design';
import type { Account } from '../src/server/auth';
import { database, type Database } from '../src/server/db';
import { accountingCsv, productionFile, reports } from '../src/server/operations';
import { createOrder, decideProof, orderDetails, publishProof, readOrder, reorder, staffTransition } from '../src/server/orders';
import { applySettlement, checkout, payInDemo, stripeEvent } from '../src/server/payments';
import { readObject, writeObject } from '../src/server/storage';
import { runGeneration } from '../src/server/worker';

const directory = mkdtempSync(path.join(tmpdir(), 'dh-workflow-'));
process.env.DH_DATA_DIR = directory;
process.env.APP_MODE = 'demo';
delete process.env.VERCEL;
after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));

const race = seedCatalogue.find((item) => item.id === 'race')!;
const config = defaultConfiguration(race);
const users = ['customer', 'customer', 'staff'].map((role, number): Account => ({
  id: randomUUID(), role: role as Account['role'], disabled: false, email: `test-${number}@example.com`, display_name: `Test ${number}`,
}));
const [buyer, stranger, staff] = users;
const csv = 'name,number\nMaya Patel,007\nRavi Shah,042\nAlexandra Fernanda Rodrigues,108';
const draft = { design: defaultDesign(race), csv, mapping: { name: 'name', number: 'number' } };

function place() {
  return createOrder(buyer, { key: randomUUID(), configuration: config, productRevision: race.revision, total: quoteProduct(race, config).total });
}

async function current(db: Database, id: string) { return readOrder(db, buyer, id); }
async function publishAndApprove(db: Database, id: string) {
  const proof = await publishProof(buyer, id, { ...draft, revision: (await current(db, id)).revision });
  await decideProof(buyer, id, { proofId: proof.id, revision: (await current(db, id)).revision });
  return proof;
}

test('race proof, payment replay, superseded checkout, interrupted render, archive and reorder', { timeout: 90000 }, async () => {
  const db = await database();
  for (const user of users) {
    await db.query('insert into printshop.accounts (id,email,display_name,role) values($1,$2,$3,$4)',
      [user.id, user.email, user.display_name, user.role]);
  }
  await assert.rejects(() => createOrder(buyer, { key: randomUUID(), configuration: config, productRevision: 1, total: 1 }), /quote has changed/);
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
  assert.deepEqual(raceReport, { family: 'race', orders: 1, revenue: 720, completed: 1, units: 3 });
  assert.match(await accountingCsv(), new RegExp(`DH${order.number}`));
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
    session: `local_${oldAttempt.attemptId}`, reference: 'test-obsolete-ref', amount: 720, currency: 'GBP', paidAt: new Date(),
  }), 'review');
  const review = await orderDetails(staff, obsolete.id);
  assert.equal(review.order.payment_review, true);
  assert.equal(review.job, undefined);
  assert.equal(review.unlocked, false);

  const signedOrder = await place();
  const signedProof = await publishAndApprove(db, signedOrder.id);
  const signedAttempt = randomUUID();
  await db.query(`insert into printshop.checkout_attempts (id,order_id,proof_id,provider,provider_session,expected_amount,currency)
    values($1,$2,$3,'stripe','cs_test_fixture',720,'GBP')`, [signedAttempt, signedOrder.id, signedProof.id]);
  const payload = JSON.stringify({ id: 'evt_signed_fixture', type: 'checkout.session.completed', livemode: false,
    created: Math.floor(Date.now() / 1000), data: { object: {
      id: 'cs_test_fixture', mode: 'payment', payment_status: 'paid', currency: 'gbp', amount_total: 720,
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
