import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { z } from 'zod';
import { ORDER_CURRENCY, PrintError, type OrderCurrency } from '@/domain/catalogue';
import type { Account } from './auth';
import { appOrigin, hosted, requiredEnv } from './config';
import { database } from './db';
import { event, readOrder, readProof, type Order } from './orders';

type Attempt = {
  id: string;
  order_id: string;
  proof_id: string;
  provider: 'demo' | 'stripe';
  provider_session: string | null;
  expected_amount: number;
  currency: OrderCurrency;
  status: 'open' | 'closed' | 'settled';
};

type Settlement = {
  provider: Attempt['provider'];
  eventId: string;
  attemptId: string;
  orderId: string;
  proofId: string;
  session: string;
  reference: string;
  amount: number;
  currency: string;
  paidAt: Date;
};

function stripe() {
  const key = requiredEnv('STRIPE_TEST_SECRET_KEY');
  if (!/^sk_test_/.test(key)) throw new Error('Stripe must use a test-mode secret key.');
  return new Stripe(key, { maxNetworkRetries: 2, timeout: 12000 });
}

export async function checkout(account: Account, orderId: string) {
  if (account.role !== 'customer') throw new PrintError('Only the customer can pay.', 403);
  const db = await database();
  const provider = hosted() ? 'stripe' : 'demo';
  const { order, attempt } = await db.transaction(async (tx) => {
    const order = await readOrder(tx, account, orderId, true);
    if (order.proof_state !== 'approved' || !order.current_proof_id || order.paid_at || order.payment_review) {
      throw new PrintError('Approve the current proof before checkout.', 409);
    }
    if (order.price.currency !== ORDER_CURRENCY) throw new PrintError('Accept an INR quote before starting checkout.', 409);
    const [open] = await tx.query<Attempt>(
      "select * from printshop.checkout_attempts where order_id=$1 and proof_id=$2 and status='open'", [orderId, order.current_proof_id]);
    if (open) return { attempt: open, order };
    const id = randomUUID();
    const [attempt] = await tx.query<Attempt>(
      `insert into printshop.checkout_attempts (id,order_id,proof_id,provider,provider_session,expected_amount,currency)
        values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [id, orderId, order.current_proof_id, provider, provider === 'demo' ? `local_${id}` : null, order.price.total, order.price.currency]);
    return { attempt, order };
  });
  if (attempt.provider !== provider) throw new PrintError('Checkout was created in a different test environment.', 409);
  if (provider === 'demo') return { demo: true as const, attemptId: attempt.id };
  const gateway = stripe();
  if (attempt.provider_session) {
    const session = await gateway.checkout.sessions.retrieve(attempt.provider_session);
    if (session.status === 'open' && session.url) return { demo: false as const, url: session.url };
    if (session.status === 'complete') throw new PrintError('The payment provider is confirming this order. Refresh in a moment.', 409);
    await db.query("update printshop.checkout_attempts set status='closed' where id=$1 and status='open'", [attempt.id]);
    return checkout(account, orderId);
  }
  const session = await gateway.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    client_reference_id: orderId,
    customer_email: account.email,
    metadata: { dh_attempt: attempt.id, dh_order: orderId, dh_proof: attempt.proof_id },
    success_url: `${appOrigin()}/orders/${orderId}?payment=checking`,
    cancel_url: `${appOrigin()}/orders/${orderId}?payment=cancelled`,
    line_items: [{
      quantity: 1, price_data: {
        currency: attempt.currency.toLowerCase(), unit_amount: attempt.expected_amount,
        product_data: { name: `DH${order.number} · ${order.product_snapshot.title}`,
          description: `${order.config.quantity} units, tax included` },
      },
    }],
  }, { idempotencyKey: `digital-heroes-${attempt.id}` });
  await db.query('update printshop.checkout_attempts set provider_session=$2 where id=$1 and provider_session is null', [attempt.id, session.id]);
  if (!session.url) throw new PrintError('The gateway did not return a checkout link. Retry shortly.', 503);
  return { demo: false as const, url: session.url };
}

export async function applySettlement(input: Settlement) {
  const db = await database();
  return db.transaction(async (tx) => {
    const [candidate] = await tx.query<Attempt>('select * from printshop.checkout_attempts where id=$1 and provider=$2',
      [input.attemptId, input.provider]);
    if (!candidate) return 'unknown';
    // Every order mutation takes the order lock before changing attempts.
    const [order] = await tx.query<Order>('select * from printshop.orders where id=$1 for update', [candidate.order_id]);
    const [attempt] = await tx.query<Attempt>('select * from printshop.checkout_attempts where id=$1 for update', [candidate.id]);
    const [newEvent] = await tx.query<{ event_id: string }>(
      `insert into printshop.payment_event_log(provider,event_id,attempt_id) values($1,$2,$3)
       on conflict do nothing returning event_id`, [input.provider, input.eventId, attempt.id]);
    if (!newEvent) return 'duplicate';
    let issue: string | undefined;
    if (input.orderId !== order.id || input.proofId !== attempt.proof_id ||
        (attempt.provider_session && attempt.provider_session !== input.session)) issue = 'Gateway checkout binding mismatch.';
    else if (input.amount !== attempt.expected_amount || input.amount !== order.price.total ||
        input.currency !== attempt.currency || input.currency !== order.price.currency) issue = 'Amount or currency mismatch.';
    else if (attempt.status !== 'open' || order.paid_at || order.current_proof_id !== attempt.proof_id ||
        order.proof_state !== 'approved' || order.payment_review) issue = 'Checkout superseded or order already settled.';
    const [payment] = await tx.query<{ id: string }>(
      `insert into printshop.payments (id,attempt_id,order_id,proof_id,provider,reference,amount,currency,status,review_reason,paid_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (provider,reference) do nothing returning id`,
    [randomUUID(), attempt.id, order.id, attempt.proof_id, input.provider, input.reference,
      input.amount, input.currency, issue ? 'review' : 'applied', issue ?? null, input.paidAt]);
    if (!payment) return 'duplicate';
    await tx.query("update printshop.checkout_attempts set status='settled',provider_session=coalesce(provider_session,$2) where id=$1",
      [attempt.id, issue ? null : input.session]);
    if (issue) {
      await tx.query('update printshop.orders set payment_review=true, revision=revision+1,updated_at=now() where id=$1', [order.id]);
      await event(tx, order.id, 'payment_review', { proof: attempt.proof_id, details: { reason: issue, reference: input.reference } });
      return 'review';
    }
    const proof = await readProof(tx, order.id, attempt.proof_id);
    await tx.query('update printshop.orders set paid_at=$2,paid_proof_id=$3,revision=revision+1,updated_at=now() where id=$1',
      [order.id, input.paidAt, proof.id]);
    await tx.query(`insert into printshop.jobs (id,order_id,proof_id,expected_rows) values($1,$2,$3,$4)
      on conflict(order_id,proof_id) do nothing`, [randomUUID(), order.id, proof.id, proof.snapshot.runners.length || 1]);
    await event(tx, order.id, 'payment_confirmed', { proof: proof.id, details: { reference: input.reference } });
    return 'applied';
  });
}

export async function payInDemo(account: Account, orderId: string, attemptId: string) {
  if (hosted()) throw new PrintError('Not found.', 404);
  const db = await database();
  const order = await readOrder(db, account, orderId);
  if (order.owner_id !== account.id || account.role !== 'customer') throw new PrintError('Order not found.', 404);
  const [attempt] = await db.query<Attempt>(
    "select * from printshop.checkout_attempts where id=$1 and order_id=$2 and provider='demo'", [attemptId, orderId]);
  if (!attempt?.provider_session) throw new PrintError('Checkout not found.', 404);
  if (attempt.currency !== ORDER_CURRENCY) throw new PrintError('Accept an INR quote before starting checkout.', 409);
  return applySettlement({
    provider: 'demo', attemptId, orderId, proofId: attempt.proof_id,
    session: attempt.provider_session, eventId: `demo_event_${attemptId}`, reference: `demo_${attemptId}`,
    amount: attempt.expected_amount, currency: attempt.currency, paidAt: new Date(),
  });
}

const metadataSchema = z.object({ dh_attempt: z.uuid(), dh_order: z.uuid(), dh_proof: z.uuid() });

export async function stripeEvent(body: string, signature: string) {
  if (!hosted()) throw new PrintError('Not found.', 404);
  const gateway = stripe();
  let incoming: Stripe.Event;
  const secret = requiredEnv('STRIPE_WEBHOOK_SECRET');
  try {
    incoming = gateway.webhooks.constructEvent(body, signature, secret);
  } catch {
    throw new PrintError('Invalid webhook signature.', 400);
  }
  if (incoming.livemode || (incoming.type !== 'checkout.session.completed' && incoming.type !== 'checkout.session.async_payment_succeeded')) return;
  const session = incoming.data.object;
  const metadata = metadataSchema.safeParse(session.metadata);
  if (!metadata.success || session.mode !== 'payment' || session.payment_status !== 'paid' ||
      !session.currency || session.amount_total === null || typeof session.payment_intent !== 'string') return;
  return applySettlement({
    provider: 'stripe', eventId: incoming.id, attemptId: metadata.data.dh_attempt, orderId: metadata.data.dh_order,
    proofId: metadata.data.dh_proof, session: session.id, reference: session.payment_intent,
    amount: session.amount_total, currency: session.currency.toUpperCase(), paidAt: new Date(incoming.created * 1000),
  });
}
