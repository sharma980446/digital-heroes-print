import { randomUUID } from 'node:crypto';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import sharp from 'sharp';
import { z } from 'zod';
import { PrintError } from '@/domain/catalogue';
import { printSize } from '@/domain/design';
import type { Account } from './auth';
import { hosted } from './config';
import { database } from './db';
import { readOrder, type Order } from './orders';
import { readObject, sha256, signedUpload, writeObject } from './storage';

export const maxUpload = 25 * 1024 * 1024;
const maxPixels = 25_000_000;
export const uploadSchema = z.object({
  kind: z.enum(['artwork', 'logo']),
  format: z.enum(['png', 'svg', 'pdf', 'ai']),
  size: z.number().int().min(1).max(maxUpload),
});
type Asset = {
  id: string;
  kind: 'artwork' | 'logo';
  format: 'png' | 'svg' | 'pdf' | 'ai';
  state: 'pending' | 'ready';
  staging_key: string;
  pixel_width: number | null;
  pixel_height: number | null;
};

export async function uploadTicket(account: Account, orderId: string, input: z.infer<typeof uploadSchema>) {
  if (input.kind === 'logo' && input.format !== 'png') throw new PrintError('Use a PNG for a logo.');
  const db = await database();
  const order = await readOrder(db, account, orderId);
  if (order.paid_at || order.payment_review) throw new PrintError('This order is locked.', 409);
  if (order.product_snapshot.personalized && input.kind === 'artwork') throw new PrintError('Use the editable race template for row-specific fields.');
  const id = randomUUID();
  const key = `staging/${orderId}/${id}.${input.format}`;
  const url = await signedUpload(key);
  await db.query('insert into printshop.assets (id,order_id,kind,format,staging_key) values ($1,$2,$3,$4,$5)',
    [id, orderId, input.kind, input.format, key]);
  return { id, url };
}

const elements = new Set(['svg', 'g', 'defs', 'rect', 'path', 'circle', 'ellipse', 'line', 'polyline',
  'polygon', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'title', 'desc']);
const attributes = new Set(['xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio', 'transform', 'd', 'x', 'y',
  'x1', 'x2', 'y1', 'y2', 'rx', 'ry', 'cx', 'cy', 'r', 'fx', 'fy', 'points', 'fill', 'fill-rule', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
  'stroke-dashoffset', 'opacity', 'id', 'gradientUnits', 'gradientTransform', 'offset', 'stop-color', 'stop-opacity', 'clip-path', 'clip-rule']);
const geometry = /^[-+eE.\d\s,%a-zA-Z()]+$/;
const safePaint = /^(#[a-f0-9]{3,8}|[a-z]+|url\(#[a-zA-Z_][\w.-]*\)|(?:rgb|rgba|hsl|hsla)\([\d.,%\s]+\))$/i;

function sized(svg: Element) {
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) return viewBox[2] / viewBox[3];
  const width = svg.getAttribute('width');
  const height = svg.getAttribute('height');
  if (width && height && /^\d*\.?\d+(px)?$/.test(width) && /^\d*\.?\d+(px)?$/.test(height)) {
    const w = parseFloat(width);
    const h = parseFloat(height);
    if (w > 0 && h > 0) {
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      return w / h;
    }
  }
  throw new PrintError('Give the SVG one explicit artboard or a viewBox.');
}

function normalizeSvg(bytes: Uint8Array, width: number, height: number) {
  if (bytes.byteLength > 2 * 1024 * 1024) throw new PrintError('Simplify the SVG to under 2 MB or export a PDF.');
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\s*<\?xml [^?]+\?>/, ''); }
  catch { throw new PrintError('Export the SVG as UTF-8.'); }
  if (/<[!?]/.test(source)) throw new PrintError('Export a plain SVG without declarations, comments or embedded content.');
  let root: Element | null;
  try { root = new DOMParser({ onError() { throw new Error(); } }).parseFromString(source, 'image/svg+xml').documentElement; }
  catch { throw new PrintError('This SVG could not be read. Export a single outlined SVG or PDF.'); }
  if (!root || root.tagName !== 'svg') throw new PrintError('The file is not an SVG.');
  let count = 0;
  const visit = (node: Element, depth: number) => {
    if (++count > 5000 || depth > 32 || !elements.has(node.tagName) || (depth > 0 && node.tagName === 'svg')) {
      throw new PrintError('Use a single outlined SVG with paths and basic shapes. PDF is available for complex artwork.');
    }
    if (node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/2000/svg') {
      throw new PrintError('Use a plain SVG with the standard SVG namespace.');
    }
    for (const attribute of Array.from(node.attributes)) {
      const { name, value } = attribute;
      const allowed = name === 'xmlns' ? value === 'http://www.w3.org/2000/svg' :
        ['fill', 'stroke', 'stop-color', 'clip-path'].includes(name) ? safePaint.test(value) :
        name === 'id' ? /^[a-zA-Z_][\w.-]*$/.test(value) : geometry.test(value);
      if (!attributes.has(name) || !allowed || (name !== 'd' && value.length > 500)) {
        throw new PrintError('This SVG uses an unsupported feature. Export outlined artwork or use PDF.');
      }
    }
    for (const child of Array.from(node.childNodes)) if (child.nodeType === 1) visit(child as Element, depth + 1);
  };
  visit(root, 0);
  checkAspect(sized(root), width, height);
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  return Buffer.from(new XMLSerializer().serializeToString(root));
}

function checkAspect(ratio: number, width: number, height: number) {
  if (Math.abs(ratio / (width / height) - 1) > .02) {
    throw new PrintError(`Export artwork matching the trim and bleed proportions (${width} × ${height} px at print resolution).`);
  }
}

async function convertPdf(bytes: Buffer, format: 'pdf' | 'ai', width: number, height: number) {
  const hint = format === 'ai' ? 'Save the Illustrator file with Create PDF Compatible File enabled, or export a PDF.' :
    'Export a readable, unencrypted, single-page PDF.';
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new PrintError(hint);
  const library = await PDFiumLibrary.init();
  try {
    const doc = await library.loadDocument(bytes);
    try {
      if (doc.getPageCount() !== 1) throw new PrintError('Use a single-page or single-artboard export.');
      const page = doc.getPage(0);
      if (format === 'ai' && /saved without pdf content|pdf compatibility turned off/i.test(page.getText().replace(/\s+/g, ' '))) {
        throw new PrintError(hint);
      }
      const { originalWidth, originalHeight } = page.getOriginalSize();
      checkAspect(originalWidth / originalHeight, width, height);
      const rendered = await page.render({ width, height, render: async ({ data, width, height }) =>
        sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer() });
      return Buffer.from(rendered.data);
    } finally { doc.destroy(); }
  } catch (error) {
    if (error instanceof PrintError) throw error;
    throw new PrintError(hint);
  } finally { library.destroy(); }
}

export async function normalizeUpload(bytes: Buffer, format: Asset['format'], kind: Asset['kind'], order: Pick<Order, 'config' | 'product_snapshot'>) {
  if (bytes.byteLength === 0 || bytes.byteLength > maxUpload) throw new PrintError('Upload a non-empty file of 25 MB or less.');
  const { widthPx, heightPx } = printSize(order.config, order.product_snapshot);
  try {
    const source = format === 'svg' ? normalizeSvg(bytes, widthPx, heightPx) :
      format === 'pdf' || format === 'ai' ? await convertPdf(bytes, format, widthPx, heightPx) : bytes;
    const picture = sharp(source, { limitInputPixels: maxPixels, failOn: 'error' });
    const metadata = await picture.metadata();
    if ((format === 'png' && metadata.format !== 'png') || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) {
      throw new PrintError('Upload an image matching the selected file type, with one page or frame.');
    }
    if (kind === 'artwork') {
      checkAspect(metadata.width / metadata.height, widthPx, heightPx);
      if (metadata.width < widthPx || metadata.height < heightPx) {
        throw new PrintError(`This image is ${metadata.width} × ${metadata.height} px. Upload at least ${widthPx} × ${heightPx} px including bleed.`);
      }
      picture.resize(widthPx, heightPx, { fit: 'fill' });
    }
    const image = await picture.toColourspace('srgb').png().toBuffer({ resolveWithObject: true });
    return { bytes: image.data, width: image.info.width, height: image.info.height };
  } catch (error) {
    if (error instanceof PrintError) throw error;
    throw new PrintError('Could not read the artwork within the print limits. Try a clean export at the requested dimensions.');
  }
}

export async function finishUpload(account: Account, orderId: string, id: string, localBytes?: Buffer) {
  const db = await database();
  const order = await readOrder(db, account, orderId);
  if (order.paid_at || order.payment_review) throw new PrintError('This order is locked.', 409);
  const [asset] = await db.query<Asset>(
    'select id,kind,format,state,staging_key,pixel_width,pixel_height from printshop.assets where id=$1 and order_id=$2', [id, orderId]);
  if (!asset) throw new PrintError('Upload not found.', 404);
  if (asset.state === 'ready') return { id, width: asset.pixel_width!, height: asset.pixel_height! };
  if (localBytes && !hosted()) {
    try { await writeObject(asset.staging_key, localBytes, 'application/octet-stream'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const bytes = await readObject(asset.staging_key, maxUpload);
  const image = await normalizeUpload(bytes, asset.format, asset.kind, order);
  const key = `assets/${orderId}/${id}-${randomUUID()}.png`;
  await writeObject(key, image.bytes, 'image/png');
  const [committed] = await db.query<{ pixel_width: number; pixel_height: number }>(`
    update printshop.assets set state='ready',object_key=$2,sha256=$3,pixel_width=$4,pixel_height=$5 where id=$1 and state='pending'
    returning pixel_width,pixel_height`, [id, key, sha256(image.bytes), image.width, image.height]);
  if (committed) return { id, width: committed.pixel_width, height: committed.pixel_height };
  const [existing] = await db.query<{ pixel_width: number; pixel_height: number }>(
    'select pixel_width,pixel_height from printshop.assets where id=$1', [id]);
  return { id, width: existing.pixel_width, height: existing.pixel_height };
}
