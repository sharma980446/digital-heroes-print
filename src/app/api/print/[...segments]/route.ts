import { z } from 'zod';
import { configurationSchema, PrintError, productSchema, quoteProduct } from '@/domain/catalogue';
import { accountReturn } from '@/domain/navigation';
import { accountForRequest, authenticate, authInput, confirmSignup, logout, requireAccount, type Account } from '@/server/auth';
import { appOrigin, checkOrigin, hosted } from '@/server/config';
import { readCsv } from '@/server/csv';
import { database } from '@/server/db';
import { accountingCsv, productionFile, receipt, reports } from '@/server/operations';
import { createOrder, createOrderInput, decideProof, draftInput, draftSnapshot, getProduct, listCatalogue, listOrders,
  orderDetails, orderFilter, publishProof, quoteInput, readOrder, readProof, reorder, reviseQuote, saveDraft, staffTransition,
  updateProduct } from '@/server/orders';
import { checkout, payInDemo, stripeEvent } from '@/server/payments';
import { artworkImages, renderPng } from '@/server/render';
import { readObject, signedDownload } from '@/server/storage';
import { finishUpload, maxUpload, uploadSchema, uploadTicket } from '@/server/uploads';
import { startDemoWorker } from '@/server/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { params: Promise<{ segments: string[] }> };
const privateHeaders = { 'Cache-Control': 'private, no-store' };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: privateHeaders });
const ok = () => json({ ok: true });
const asId = (id: string | undefined) => {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new PrintError('Not found.', 404);
  return parsed.data;
};

async function bodyBytes(req: Request, limit: number) {
  if (Number(req.headers.get('content-length')) > limit) throw new PrintError('This upload exceeds the request size limit.', 413);
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new PrintError('This upload exceeds the request size limit.', 413);
    }
    parts.push(value);
  }
  return Buffer.concat(parts, size);
}

async function input(req: Request): Promise<unknown> {
  const bytes = await bodyBytes(req, 1024 * 1024);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new PrintError('Send a valid UTF-8 JSON request.', 400); }
}

function errorResponse(error: unknown) {
  if (error instanceof PrintError) return json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return json({ error: issue.path.length ? `Check ${issue.path.map(String).join(' / ')}. ${issue.message}` : 'Check the submitted information.' }, 422);
  }
  console.error('Print API error', error instanceof Error ? error.name : 'Unknown');
  return json({ error: 'This request could not be completed. Try again.' }, 500);
}

function blob(bytes: Uint8Array, mime: string, filename?: string) {
  const buffer = Uint8Array.from(bytes);
  return new Response(buffer, { headers: {
    ...privateHeaders, 'Content-Type': mime,
    ...(filename ? { 'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"` } : {}),
  } });
}

const rowSchema = z.coerce.number().int().min(0).max(1000);
function filters(url: URL) {
  return orderFilter.parse(Object.fromEntries([...url.searchParams.entries()].filter(([, value]) => !!value)));
}

async function getOrderPart(account: Account, id: string, trail: string[], url: URL) {
  if (!trail.length) return json(await orderDetails(account, id));
  const [kind, key, format] = trail;
  if (kind === 'receipt' && trail.length === 1) {
    const result = await receipt(account, id);
    return blob(result.bytes, 'application/pdf', result.filename);
  }
  if (kind === 'proof' && trail.length === 2) {
    const db = await database();
    await readOrder(db, account, id);
    const proof = await readProof(db, id, asId(key));
    const row = rowSchema.parse(url.searchParams.get('row') ?? '0');
    if (row >= (proof.snapshot.runners.length || 1)) throw new PrintError('Proof row not found.', 404);
    const bytes = await renderPng(proof.snapshot, row, await artworkImages(proof.snapshot), true);
    return blob(bytes, 'image/png', url.searchParams.has('download') ? `Proof_v${proof.version}_row-${row + 1}.png` : undefined);
  }
  if (kind === 'files' && trail.length === 3) {
    const file = await productionFile(account, id, rowSchema.max(2000).parse(key), z.enum(['pdf', 'png', 'zip']).parse(format));
    const direct = await signedDownload(file.object_key, file.filename);
    if (direct) return new Response(null, { status: 303, headers: { ...privateHeaders, Location: direct } });
    return blob(await readObject(file.object_key),
      file.format === 'pdf' ? 'application/pdf' : file.format === 'png' ? 'image/png' : 'application/zip', file.filename);
  }
  throw new PrintError('Not found.', 404);
}

export async function GET(req: Request, { params }: Params) {
  try {
    const path = (await params).segments;
    const url = new URL(req.url);
    if (path.join('/') === 'auth/confirm') {
      const confirmed = await confirmSignup(url);
      const next = new URL(confirmed ? accountReturn(url.searchParams.get('next')) : '/account?confirmation=failed', appOrigin());
      return Response.redirect(next, 303);
    }
    startDemoWorker();
    if (path.join('/') === 'catalogue') return json(await listCatalogue());
    if (path.join('/') === 'auth/session') return json({ account: await accountForRequest(), demo: !hosted() });
    if (path[0] === 'orders') {
      const account = await requireAccount();
      if (path.length === 1) return json(await listOrders(account, filters(url)));
      return await getOrderPart(account, asId(path[1]), path.slice(2), url);
    }
    if (path[0] === 'staff' && path.length === 2) {
      await requireAccount(true);
      switch (path[1]) {
        case 'catalogue': return json(await listCatalogue(true));
        case 'reports': {
          const filter = filters(url);
          return json(await reports(filter.from, filter.to));
        }
        case 'accounts': {
          return json(await (await database()).query<Account>('select * from printshop.accounts order by created_at desc limit 200'));
        }
        case 'export': return blob(Buffer.from(await accountingCsv()), 'text/csv; charset=utf-8', 'Digital_Heroes_accounting.csv');
      }
    }
    throw new PrintError('Not found.', 404);
  } catch (error) { return errorResponse(error); }
}

async function orderAction(req: Request, account: Account, id: string, trail: string[]) {
  const [action, key] = trail;
  if (action === 'upload' && trail.length === 2) {
    return json(await finishUpload(account, id, asId(key), hosted() ? undefined : await bodyBytes(req, maxUpload)));
  }
  if (trail.length !== 1) throw new PrintError('Not found.', 404);
  switch (action) {
    case 'upload': return json(await uploadTicket(account, id, uploadSchema.parse(await input(req))), 201);
    case 'inspect-csv': {
      await readOrder(await database(), account, id);
      const { csv } = z.object({ csv: z.string().max(256 * 1024) }).parse(await input(req));
      const parsed = readCsv(csv);
      return json({ headers: parsed.headers, count: parsed.rows.length, examples: parsed.rows.slice(0, 3) });
    }
    case 'configure': {
      await reviseQuote(account, id, quoteInput.extend({ revision: z.number().int().positive() }).parse(await input(req)));
      return ok();
    }
    case 'draft': {
      await saveDraft(account, id, draftInput.parse(await input(req)));
      return ok();
    }
    case 'preview': {
      const fields = draftInput.extend({ row: z.number().int().min(0).max(999) }).parse(await input(req));
      const db = await database();
      const order = await readOrder(db, account, id);
      if (order.revision !== fields.revision) throw new PrintError('This order changed. Refresh before previewing.', 409);
      const snapshot = await draftSnapshot(db, order, fields.design, fields.csv, fields.mapping);
      return blob(await renderPng(snapshot, fields.row, await artworkImages(snapshot), true, true), 'image/png');
    }
    case 'publish': {
      const proof = await publishProof(account, id, draftInput.parse(await input(req)));
      return json({ id: proof.id, version: proof.version }, 201);
    }
    case 'approve':
    case 'changes': {
      const base = z.object({ proofId: z.uuid(), revision: z.number().int().positive() });
      const data = await input(req);
      await decideProof(account, id, action === 'approve' ? base.parse(data) :
        base.extend({ comment: z.string().trim().min(1).max(2000) }).parse(data));
      return ok();
    }
    case 'checkout': return json(await checkout(account, id));
    case 'demo-payment': {
      const { attemptId } = z.object({ attemptId: z.uuid() }).parse(await input(req));
      return json({ result: await payInDemo(account, id, attemptId) });
    }
    case 'reorder': {
      const { key } = z.object({ key: z.uuid() }).parse(await input(req));
      return json({ id: (await reorder(account, id, key)).id }, 201);
    }
    case 'stage': {
      const { action, note } = z.object({ action: z.enum(['start', 'complete', 'retry', 'resolve']),
        note: z.string().trim().max(2000).optional() }).parse(await input(req));
      await staffTransition(account, id, action, note);
      return ok();
    }
    default: throw new PrintError('Not found.', 404);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const path = (await params).segments;
    const endpoint = path.join('/');
    if (endpoint === 'stripe/webhook') {
      await stripeEvent((await bodyBytes(req, 1024 * 1024)).toString('utf8'), req.headers.get('stripe-signature') ?? '');
      return ok();
    }
    checkOrigin(req);
    startDemoWorker();
    if (endpoint === 'quote') {
      const config = configurationSchema.parse(await input(req));
      const product = await getProduct(await database(), config.productId);
      return json({ price: quoteProduct(product, config), productRevision: product.revision });
    }
    if (endpoint === 'auth/signup' || endpoint === 'auth/login') {
      return json(await authenticate(authInput.parse(await input(req)), endpoint === 'auth/signup'));
    }
    if (endpoint === 'auth/logout') {
      await logout();
      return ok();
    }
    if (endpoint === 'auth/profile') {
      const account = await requireAccount();
      const { name } = z.object({ name: z.string().trim().min(2).max(80) }).parse(await input(req));
      await (await database()).query('update printshop.accounts set display_name=$2 where id=$1', [account.id, name]);
      return ok();
    }
    if (path[0] === 'orders') {
      const account = await requireAccount();
      if (path.length === 1) {
        const order = await createOrder(account, createOrderInput.parse(await input(req)));
        return json({ id: order.id }, 201);
      }
      return await orderAction(req, account, asId(path[1]), path.slice(2));
    }
    if (endpoint === 'staff/catalogue') {
      const account = await requireAccount(true);
      await updateProduct(account, productSchema.parse(await input(req)));
      return ok();
    }
    if (endpoint === 'staff/accounts') {
      const account = await requireAccount(true);
      const { id, disabled } = z.object({ id: z.uuid(), disabled: z.boolean() }).parse(await input(req));
      if (id === account.id) throw new PrintError('Your own account cannot be disabled here.');
      const [updated] = await (await database()).query<{ id: string }>(
        "update printshop.accounts set disabled=$2 where id=$1 and role='customer' returning id", [id, disabled]);
      if (!updated) throw new PrintError('Customer account not found.', 404);
      return ok();
    }
    throw new PrintError('Not found.', 404);
  } catch (error) { return errorResponse(error); }
}
