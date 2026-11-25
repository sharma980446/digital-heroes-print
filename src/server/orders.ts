import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { configurationSchema, money, PrintError, productSchema, quoteProduct, storedCurrencies,
  type Configuration, type OrderCurrency, type PriceSnapshot, type Product, type ProductSnapshot, type Quote } from '@/domain/catalogue';
import { defaultDesign, designSchema, type Design, type PrintAsset, type Snapshot } from '@/domain/design';
import type { Account } from './auth';
import { hosted } from './config';
import { mapRunners, readCsv } from './csv';
import { database, type Query } from './db';
import { validateArtwork } from './render';
import { sha256 } from './storage';

export type Stage = 'order' | 'artwork' | 'proof' | 'production' | 'completed';
export type Order = {
  id: string;
  number: string;
  owner_id: string;
  product_id: string;
  config: Configuration;
  product_snapshot: ProductSnapshot;
  price: PriceSnapshot;
  draft: Design;
  draft_csv: string;
  draft_mapping: { name: string; number: string };
  stage: Stage;
  proof_state: 'draft' | 'review' | 'changes' | 'approved';
  current_proof_id: string | null;
  paid_proof_id: string | null;
  paid_at: Date | null;
  payment_review: boolean;
  reordered_from: string | null;
  revision: number;
  created_at: Date;
  completed_at: Date | null;
};

export type Proof = {
  id: string;
  order_id: string;
  version: number;
  snapshot: Snapshot;
  sha256: string;
  hash_format: 'json-v0' | 'canonical-v1';
  created_at: Date;
};

export type Job = {
  id: string;
  order_id: string;
  proof_id: string;
  status: 'queued' | 'running' | 'ready' | 'failed';
  expected_rows: number;
  processed_rows: number;
  attempts: number;
  error: string | null;
};

export type ProductionFile = {
  row_number: number;
  format: 'pdf' | 'png' | 'zip';
  filename: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
};

export const quoteInput = z.object({
  configuration: configurationSchema,
  currency: z.enum(storedCurrencies),
  total: z.number().int().nonnegative(),
  productRevision: z.number().int().positive(),
});
export const createOrderInput = quoteInput.extend({ key: z.uuid() });
export const mappingSchema = z.object({ name: z.string().max(80), number: z.string().max(80) });
export const draftInput = z.object({
  revision: z.number().int().positive(),
  design: designSchema,
  csv: z.string().max(256 * 1024),
  mapping: mappingSchema,
});

const j = (value: unknown) => JSON.stringify(value);

export function snapshotHash(snapshot: Snapshot) {
  // JSONB does not preserve object key order.
  return sha256(JSON.stringify(snapshot, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value));
}

export async function listCatalogue(includeInactive = false) {
  const db = await database();
  return (await db.query<{ definition: Product }>(
    "select definition from printshop.catalogue where $1::boolean or definition->>'active' = 'true' order by id", [includeInactive],
  )).map(({ definition }) => definition);
}

export async function getProduct(db: Query, id: string) {
  const [row] = await db.query<{ definition: Product }>('select definition from printshop.catalogue where id = $1', [id]);
  if (!row) throw new PrintError('Product not found.', 404);
  return row.definition;
}

async function checkedQuote(db: Query, input: z.infer<typeof quoteInput>) {
  const product = await getProduct(db, input.configuration.productId);
  const price = quoteProduct(product, input.configuration);
  if (product.revision !== input.productRevision || price.currency !== input.currency || price.total !== input.total) {
    throw new PrintError(`This quote has changed to ${money(price.total, price.currency)}. Refresh the quote and confirm the current price.`, 409);
  }
  return { product, price };
}

export async function event(db: Query, orderId: string, eventType: string,
  options: { actor?: string; proof?: string; details?: object; notify?: boolean } = {}) {
  const [result] = await db.query<{ id: string }>(
    'insert into printshop.order_events (order_id, actor_id, proof_id, event_type, detail) values ($1, $2, $3, $4, $5) returning id',
    [orderId, options.actor ?? null, options.proof ?? null, eventType, j(options.details ?? {})]);
  if (options.notify) {
    await db.query(`insert into printshop.notifications (id, event_id, recipient, status)
      select $1, $2, a.email, $4 from printshop.orders o join printshop.accounts a on a.id = o.owner_id where o.id = $3`,
    [randomUUID(), result.id, orderId, hosted() ? 'pending' : 'demo']);
  }
}

export async function readOrder(db: Query, account: Account, id: string, lock = false) {
  const [order] = await db.query<Order>(
    `select * from printshop.orders where id = $1 and ($2::boolean or owner_id = $3)${lock ? ' for update' : ''}`,
    [id, account.role === 'staff', account.id]);
  if (!order) throw new PrintError('Order not found.', 404);
  return order;
}

const requireCustomer = (account: Account) => {
  if (account.role !== 'customer') throw new PrintError('Sign in as a customer to place an order.', 403);
};
const requireOwner = (account: Account, order: Order) => {
  if (account.id !== order.owner_id || account.role !== 'customer') throw new PrintError('Only the customer can approve or pay for this order.', 403);
};

async function insertOrder(tx: Query, account: Account, key: string, config: Configuration, product: Product, price: Quote,
  design: Design, source?: Order) {
  const [order] = await tx.query<Order>(
    `insert into printshop.orders (id, owner_id, product_id, idempotency_key, config, product_snapshot, price, draft, draft_csv, draft_mapping, reordered_from)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (owner_id, idempotency_key) do nothing returning *`,
    [randomUUID(), account.id, product.id, key, j(config), j(product), j(price), j(design), source?.draft_csv ?? '',
      j(source?.draft_mapping ?? { name: 'name', number: 'number' }), source?.id ?? null]);
  if (!order) {
    const [existing] = await tx.query<Order>('select * from printshop.orders where owner_id = $1 and idempotency_key = $2', [account.id, key]);
    if (existing.product_id !== config.productId || existing.price.currency !== price.currency || existing.price.total !== price.total ||
        Object.keys(config).some((field) => config[field as keyof Configuration] !== existing.config[field as keyof Configuration]) ||
        existing.reordered_from !== (source?.id ?? null)) {
      throw new PrintError('A different order already used this confirmation. Submit the current quote again.', 409);
    }
    return { order: existing, inserted: false };
  }
  await event(tx, order.id, 'order_created', { actor: account.id, notify: true });
  return { order, inserted: true };
}

export async function createOrder(account: Account, input: z.infer<typeof createOrderInput>) {
  requireCustomer(account);
  return (await database()).transaction(async (tx) => {
    const [existing] = await tx.query<Order>('select * from printshop.orders where owner_id=$1 and idempotency_key=$2', [account.id, input.key]);
    if (existing) {
      if (existing.price.currency !== input.currency || existing.price.total !== input.total || existing.product_snapshot.revision !== input.productRevision ||
          Object.keys(input.configuration).some((key) => existing.config[key as keyof Configuration] !== input.configuration[key as keyof Configuration]) ||
          existing.reordered_from) throw new PrintError('This confirmation already belongs to another order.', 409);
      return existing;
    }
    const { product, price } = await checkedQuote(tx, input);
    return (await insertOrder(tx, account, input.key, input.configuration, product, price, defaultDesign(product))).order;
  });
}

function editable(order: Order, revision: number) {
  if (order.paid_at || order.payment_review) throw new PrintError('This order is locked. Use a new order for further changes.', 409);
  if (order.revision !== revision) throw new PrintError('This order changed. Review the current version and try again.', 409);
}

async function closeAttempts(db: Query, orderId: string) {
  await db.query("update printshop.checkout_attempts set status = 'closed' where order_id = $1 and status = 'open'", [orderId]);
}

export async function reviseQuote(account: Account, id: string, input: z.infer<typeof quoteInput> & { revision: number }) {
  return (await database()).transaction(async (tx) => {
    const order = await readOrder(tx, account, id, true);
    requireOwner(account, order);
    editable(order, input.revision);
    if (order.product_id !== input.configuration.productId) throw new PrintError('Start a new order for a different product.');
    const { product, price } = await checkedQuote(tx, input);
    await closeAttempts(tx, id);
    await tx.query(`update printshop.orders set config=$2, product_snapshot=$3, price=$4, stage='artwork',
      proof_state='draft', revision=revision+1, updated_at=now() where id=$1`, [id, j(input.configuration), j(product), j(price)]);
    await event(tx, id, 'quote_revised', { actor: account.id, details: { currency: price.currency, total: price.total, configuration: input.configuration } });
  });
}

export async function saveDraft(account: Account, id: string, input: z.infer<typeof draftInput>) {
  await (await database()).transaction(async (tx) => {
    const order = await readOrder(tx, account, id, true);
    editable(order, input.revision);
    await closeAttempts(tx, id);
    await tx.query(`update printshop.orders set draft=$2, draft_csv=$3, draft_mapping=$4, stage='artwork',
      proof_state='draft', revision=revision+1, updated_at=now() where id=$1`, [id, j(input.design), input.csv, j(input.mapping)]);
    await event(tx, id, 'draft_saved', { actor: account.id });
  });
}

export async function draftSnapshot(db: Query, order: Order, design: Design, csv: string, mapping: z.infer<typeof mappingSchema>): Promise<Snapshot> {
  const product = order.product_snapshot;
  const runners = product.personalized ? mapRunners(readCsv(csv), mapping, order.config.quantity) : [];
  const assetIds = design.mode === 'upload' ? [design.assetId] :
    [...new Set(design.elements.flatMap((element) => element.kind === 'logo' ? [element.assetId] : []))];
  const assets = assetIds.length ? await db.query<PrintAsset>(`
    select a.id, a.object_key as key, a.sha256, a.pixel_width as width, a.pixel_height as height, a.kind
    from printshop.assets a join printshop.orders o on o.id = a.order_id
    where a.id = any($1::uuid[]) and o.owner_id = $2 and a.state = 'ready' order by a.id`, [assetIds, order.owner_id]) : [];
  if (assets.length !== assetIds.length) throw new PrintError('One of these images is unavailable. Upload it again.');
  return { renderer: 'rgb-v1', config: order.config, product, design, runners, assets };
}

async function appendProof(tx: Query, order: Order, snapshot: Snapshot, actor: string, carried?: string) {
  const proofId = randomUUID();
  const [proof] = await tx.query<Proof>(`
    insert into printshop.proofs (id,order_id,version,snapshot,sha256,published_by)
    select $1,$2,coalesce(max(version),0)+1,$3,$4,$5 from printshop.proofs where order_id=$2
    returning *`, [proofId, order.id, j(snapshot), snapshotHash(snapshot), actor]);
  await tx.query(`update printshop.orders set current_proof_id=$2, stage='proof',
    proof_state=$3, revision=revision+1, updated_at=now() where id=$1`, [order.id, proofId, carried ? 'approved' : 'review']);
  await event(tx, order.id, 'proof_published', { actor, proof: proofId, details: { version: proof.version }, notify: !carried });
  if (carried) {
    await tx.query('insert into printshop.approvals (proof_id, actor_id, carried_from) values ($1, $2, $3)', [proofId, actor, carried]);
    await event(tx, order.id, 'approval_reused', { actor, proof: proofId, details: { from: carried } });
  }
  return proof;
}

export async function publishProof(account: Account, id: string, input: z.infer<typeof draftInput>) {
  const db = await database();
  const order = await readOrder(db, account, id);
  editable(order, input.revision);
  const snapshot = await draftSnapshot(db, order, input.design, input.csv, input.mapping);
  validateArtwork(snapshot);
  return db.transaction(async (tx) => {
    const locked = await readOrder(tx, account, id, true);
    editable(locked, input.revision);
    await closeAttempts(tx, id);
    await tx.query('update printshop.orders set draft=$2, draft_csv=$3, draft_mapping=$4 where id=$1',
      [id, j(input.design), input.csv, j(input.mapping)]);
    return appendProof(tx, locked, snapshot, account.id);
  });
}

export async function readProof(db: Query, orderId: string, proofId: string) {
  const [proof] = await db.query<Proof>('select * from printshop.proofs where id=$1 and order_id=$2', [proofId, orderId]);
  if (!proof) throw new PrintError('Proof not found.', 404);
  return proof;
}

export async function decideProof(account: Account, id: string, input: { proofId: string; revision: number; comment?: string }) {
  await (await database()).transaction(async (tx) => {
    const order = await readOrder(tx, account, id, true);
    requireOwner(account, order);
    editable(order, input.revision);
    if (order.current_proof_id !== input.proofId || order.proof_state !== 'review') {
      throw new PrintError('This proof has changed. Open the current version to review it.', 409);
    }
    if (input.comment) {
      await closeAttempts(tx, id);
      await tx.query(`update printshop.orders set stage='artwork', proof_state='changes', revision=revision+1, updated_at=now() where id=$1`, [id]);
      await event(tx, id, 'changes_requested', { actor: account.id, proof: input.proofId, details: { comment: input.comment } });
      return;
    }
    await tx.query('insert into printshop.approvals (proof_id, actor_id) values ($1,$2)', [input.proofId, account.id]);
    await tx.query("update printshop.orders set proof_state='approved', revision=revision+1, updated_at=now() where id=$1", [id]);
    await event(tx, id, 'proof_approved', { actor: account.id, proof: input.proofId, notify: true });
  });
}

export function productionUnlocked(order: Order, job?: Job) {
  return order.proof_state === 'approved' && order.paid_at !== null && !order.payment_review &&
    order.paid_proof_id === order.current_proof_id && job?.status === 'ready' &&
    job.proof_id === order.current_proof_id && job.processed_rows === job.expected_rows;
}

export async function currentJob(db: Query, id: string) {
  const [job] = await db.query<Job>(`
    select j.id,j.order_id,j.proof_id,j.status,j.processed_rows,j.expected_rows,j.attempts,j.error
    from printshop.jobs j join printshop.orders o on o.id=j.order_id and o.current_proof_id=j.proof_id where o.id=$1`, [id]);
  return job;
}

export async function orderDetails(account: Account, id: string) {
  const db = await database();
  const order = await readOrder(db, account, id);
  const proofs = await db.query<{
    id: string; version: number; sha256: string; created_at: Date; approved_at: Date | null; approver: string | null;
    carried_from: string | null; names: { name: string; number: string }[];
  }>(`select p.id, p.version, p.sha256, p.created_at, a.approved_at, account.display_name as approver, a.carried_from,
    p.snapshot->'runners' as names from printshop.proofs p
    left join printshop.approvals a on a.proof_id=p.id left join printshop.accounts account on account.id=a.actor_id
    where p.order_id=$1 order by p.version desc`, [id]);
  const timeline = await db.query<{ id: string; event_type: string; created_at: Date; detail: Record<string, string>; actor: string | null }>(`
    select e.id,e.event_type,e.created_at,e.detail,a.display_name as actor from printshop.order_events e
    left join printshop.accounts a on a.id=e.actor_id where e.order_id=$1 order by e.id desc limit 60`, [id]);
  const payments = await db.query<{ amount: number; currency: string; reference: string; provider: string; status: string; paid_at: Date; review_reason: string | null }>(`
    select amount,currency,reference,provider,status,paid_at,review_reason from printshop.payments where order_id=$1 order by paid_at desc`, [id]);
  const job = await currentJob(db, id);
  const unlocked = account.role === 'staff' && productionUnlocked(order, job);
  const files = unlocked ? await db.query<Omit<ProductionFile, 'object_key'>>(
    'select row_number,format,filename,sha256,size_bytes from printshop.manifest where job_id=$1 order by row_number,format',
    [job!.id]) : [];
  const notifications = account.role === 'staff' ? await db.query<{ event_type: string; status: string; sent_at: Date | null }>(`
    select e.event_type,n.status,n.sent_at from printshop.notifications n join printshop.order_events e on e.id=n.event_id
    where e.order_id=$1 order by e.id desc`, [id]) : [];
  return { order, proofs, timeline, payments, job, unlocked, files, notifications };
}

export const orderFilter = z.object({
  stage: z.enum(['order', 'artwork', 'proof', 'production', 'completed']).optional(),
  family: z.string().max(40).optional(),
  search: z.string().trim().max(100).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export async function listOrders(account: Account, filters: z.infer<typeof orderFilter>) {
  return (await database()).query<{
    id: string; number: string; stage: Stage; title: string; quantity: number; amount: number; currency: OrderCurrency; created_at: Date;
    customer: string; product_id: string; proof_state: Order['proof_state']; paid: boolean; payment_review: boolean; files: string | null;
    configuration: Configuration; proof_id: string | null;
  }>(`select o.id,o.number,o.stage,o.product_snapshot->>'title' as title,(o.config->>'quantity')::int as quantity,
      (o.price->>'total')::int as amount,o.price->>'currency' as currency,o.created_at,a.display_name as customer,o.product_id,o.proof_state,
      o.paid_at is not null as paid,o.payment_review,j.status as files,o.config as configuration,o.current_proof_id as proof_id
    from printshop.orders o join printshop.accounts a on a.id=o.owner_id
    left join printshop.jobs j on j.order_id=o.id and j.proof_id=o.current_proof_id
    where ($1::boolean or o.owner_id=$2) and ($3::text is null or o.stage=$3) and ($4::text is null or o.product_id=$4)
      and ($5::text is null or strpos(lower(a.display_name),lower($5))>0 or strpos(lower(a.email),lower($5))>0 or
        strpos(lower('DH'||o.number::text),lower($5))>0)
      and ($6::date is null or o.created_at >= ($6::date::timestamp at time zone 'UTC'))
      and ($7::date is null or o.created_at < (($7::date + 1)::timestamp at time zone 'UTC'))
    order by o.created_at desc limit 250`,
  [account.role === 'staff', account.id, filters.stage ?? null, filters.family ?? null, filters.search ?? null, filters.from ?? null, filters.to ?? null]);
}

export async function staffTransition(account: Account, id: string, action: 'start' | 'complete' | 'retry' | 'resolve', note?: string) {
  if (account.role !== 'staff') throw new PrintError('Staff access is required.', 403);
  await (await database()).transaction(async (tx) => {
    const order = await readOrder(tx, account, id, true);
    const job = await currentJob(tx, id);
    if (action === 'resolve') {
      if (!order.payment_review || !note) throw new PrintError('Record how the payment issue was resolved.');
      await tx.query('update printshop.orders set payment_review=false, revision=revision+1, updated_at=now() where id=$1', [id]);
      await event(tx, id, 'payment_review_resolved', { actor: account.id, details: { comment: note } });
      return;
    }
    if (action === 'retry') {
      if (job?.status !== 'failed' || order.payment_review || order.paid_proof_id !== order.current_proof_id) {
        throw new PrintError('Only a failed generation on the paid approval can be retried.', 409);
      }
      await tx.query("update printshop.jobs set status='queued',processed_rows=0,lease_token=null,lease_until=null,error=null,updated_at=now() where id=$1", [job.id]);
      await event(tx, id, 'generation_retried', { actor: account.id, proof: job.proof_id });
      return;
    }
    if (!productionUnlocked(order, job) || (action === 'start' ? order.stage !== 'proof' : order.stage !== 'production')) {
      throw new PrintError('The order is not ready for that transition.', 409);
    }
    const stage = action === 'start' ? 'production' : 'completed';
    await tx.query(`update printshop.orders set stage=$2,revision=revision+1,updated_at=now(),
      completed_at=case when $2='completed' then now() else null end where id=$1`, [id, stage]);
    await event(tx, id, stage === 'production' ? 'production_started' : 'order_completed',
      { actor: account.id, proof: job!.proof_id, notify: true });
  });
}

export async function reorder(account: Account, id: string, key: string) {
  requireCustomer(account);
  return (await database()).transaction(async (tx) => {
    const original = await readOrder(tx, account, id, true);
    requireOwner(account, original);
    if (!original.paid_proof_id || original.payment_review) throw new PrintError('Select a paid order with a saved design.');
    const proof = await readProof(tx, original.id, original.paid_proof_id);
    const product = await getProduct(tx, original.product_id);
    const { config, design } = proof.snapshot;
    if (!product.materials.some(({ id }) => id === config.material)) {
      throw new PrintError('This material was retired. Configure a new order with an available material.');
    }
    const price = quoteProduct(product, config);
    const created = await insertOrder(tx, account, key, config, product, price, design, original);
    if (created.inserted) {
      const profile = proof.snapshot.product;
      const sameMaterial = product.materials.find(({ id }) => id === config.material)?.title ===
        profile.materials.find(({ id }) => id === config.material)?.title;
      if (sameMaterial && product.ppi === profile.ppi && product.bleed === profile.bleed &&
          product.safeInset === profile.safeInset && product.personalized === profile.personalized) {
        await appendProof(tx, created.order, proof.snapshot, account.id, proof.id);
      }
    }
    return created.order;
  });
}

export async function updateProduct(account: Account, proposed: Product) {
  if (account.role !== 'staff') throw new PrintError('Staff access is required.', 403);
  const product = productSchema.parse(proposed);
  if (Math.min(product.referenceWidth, product.referenceHeight) / 2 - 2 * product.safeInset < 1) {
    throw new PrintError('The smallest supported size must have a usable safe area.');
  }
  const db = await database();
  const [row] = await db.query<{ id: string }>(`update printshop.catalogue set definition=$2,updated_at=now()
    where id=$1 and (definition->>'revision')::int=$3 returning id`,
  [product.id, j({ ...product, revision: product.revision + 1 }), product.revision]);
  if (!row) throw new PrintError('The catalogue changed. Reload the current settings.', 409);
}
