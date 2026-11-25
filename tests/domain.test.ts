import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PDFDocument, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { defaultConfiguration, quoteProduct, seedCatalogue } from '../src/domain/catalogue';
import { defaultDesign, insideSafeArea, printSize, type Snapshot } from '../src/domain/design';
import { mapRunners, readCsv } from '../src/server/csv';
import { renderPdf, renderPng, validateArtwork } from '../src/server/render';
import { normalizeUpload } from '../src/server/uploads';

const stickers = seedCatalogue.find((product) => product.id === 'stickers')!;
const race = seedCatalogue.find((product) => product.id === 'race')!;
const config = defaultConfiguration(stickers);

test('computes all sticky pricing examples, both thresholds and half-up tax', () => {
  assert.equal(quoteProduct(stickers, config).total, 10800);
  assert.equal(quoteProduct(stickers, { ...config, quantity: 99 }).total, 11880);
  assert.equal(quoteProduct(stickers, { ...config, material: 'gloss' }).total, 12960);
  assert.equal(quoteProduct(stickers, { ...config, quantity: 499 }).total, 53892);
  assert.equal(quoteProduct(stickers, { ...config, quantity: 500 }).total, 51000);
  assert.deepEqual(quoteProduct(stickers, { ...config, width: 25, height: 51, orientation: 'portrait', quantity: 1 }),
    { currency: 'GBP', basePence: 100, referenceAreaMm2: 2500, materialMultiplierBps: 10000, material: 'Matte vinyl',
      discountBps: 0, vatBps: 2000, beforeDiscount: 51, discount: 0, subtotal: 51, tax: 10, total: 61, unitAverage: 61 });
  assert.equal(quoteProduct({ ...stickers, basePence: 102 }, { ...config, width: 25, height: 25, quantity: 1 }).subtotal, 26);
  assert.throws(() => quoteProduct(stickers, { ...config, width: 24 }), /width/);
  assert.throws(() => quoteProduct(stickers, { ...config, quantity: 0 }));
  assert.throws(() => quoteProduct(stickers, { ...config, material: 'rubber' }), /material/);
});

test('applies rotated geometry at the safe boundary', () => {
  assert.equal(insideSafeArea(9, 14, 10, 20, 0, config, 3), true);
  assert.equal(insideSafeArea(9, 14, 10, 20, 90, config, 3), false);
});

test('maps UTF-8, quoted CSV fields and leading-zero bibs', () => {
  const sample = readCsv('\ufeffcode,competitor\r\n007,"María, Jr."\r\n010,Alex');
  assert.deepEqual(mapRunners(sample, { name: 'competitor', number: 'code' }, 2),
    [{ name: 'María, Jr.', number: '007' }, { name: 'Alex', number: '010' }]);
  assert.throws(() => mapRunners(sample, { name: 'competitor', number: 'code' }, 3), /3 units.*2 rows/);
  assert.throws(() => mapRunners(readCsv('name,number\nMaya,007\nSam,7'), { name: 'name', number: 'number' }, 2), /Row 2.*duplicates/);
  assert.throws(() => readCsv(`name,number\n${Array.from({ length: 1001 }, (_, i) => `A,${i}`).join('\n')}`), /1,000/);
});

test('renders exact PNG pixels, density and PDF media, trim and bleed boxes', async () => {
  const snapshot: Snapshot = { renderer: 'rgb-v1', config, product: stickers, design: defaultDesign(stickers), runners: [], assets: [] };
  const png = await renderPng(snapshot, 0, new Map());
  const image = await sharp(png).metadata();
  assert.equal(image.width, 661);
  assert.equal(image.height, 661);
  assert.equal(image.density, 300);
  const pdf = await PDFDocument.load(await renderPdf(snapshot, png, 'Sticker proof'));
  const page = pdf.getPage(0);
  assert.ok(Math.abs(page.getTrimBox().width / 72 * 25.4 - 50) < 0.000001);
  assert.ok(Math.abs(page.getTrimBox().x / 72 * 25.4 - 3) < 0.000001);
  assert.ok(Math.abs(page.getBleedBox().width / 72 * 25.4 - 56) < 0.000001);
  assert.deepEqual(page.getMediaBox(), page.getBleedBox());
});

test('validates every race row and renders names and numbers independently', async () => {
  const runners = mapRunners(readCsv(await readFile('public/samples/runners.csv', 'utf8')), { name: 'name', number: 'number' }, 3);
  const snap: Snapshot = { renderer: 'rgb-v1', config: defaultConfiguration(race), product: race,
    design: defaultDesign(race), runners, assets: [] };
  assert.doesNotThrow(() => validateArtwork(snap));
  assert.notDeepEqual(await renderPng(snap, 0, new Map(), true), await renderPng(snap, 1, new Map(), true));
  assert.throws(() => validateArtwork({ ...snap, runners: [...runners.slice(0, 2), { number: '007', name: 'W'.repeat(120) }] }), /Row 3, name.*will not fit/);
});

test('normalizes PNG, outlined SVG, PDF and PDF-compatible AI', async () => {
  const order = { config, product_snapshot: stickers };
  const { widthPx, heightPx } = printSize(config, stickers);
  const png = await sharp({ create: { width: widthPx, height: heightPx, channels: 3, background: '#5eaa61' } }).png().toBuffer();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><rect width="56" height="56" fill="#5eaa61"/></svg>');
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([158.74, 158.74]);
  page.drawRectangle({ width: 158.74, height: 158.74, color: rgb(.8, .2, .15) });
  const pdfBytes = Buffer.from(await pdf.save());
  for (const [format, bytes] of [['png', png], ['svg', svg], ['pdf', pdfBytes], ['ai', pdfBytes]] as const) {
    const result = await normalizeUpload(bytes, format, 'artwork', order);
    assert.deepEqual([result.width, result.height], [661, 661], format);
  }
  const red = await normalizeUpload(pdfBytes, 'pdf', 'artwork', order);
  const [redChannel, , blueChannel] = await sharp(red.bytes).raw().toBuffer();
  assert.ok(redChannel > blueChannel, 'PDF raster preserves red and blue channels');
  const small = await sharp(png).resize(40, 40).png().toBuffer();
  await assert.rejects(() => normalizeUpload(small, 'png', 'artwork', order), /Upload at least 661/);
  await assert.rejects(() => normalizeUpload(Buffer.from('not a PDF'), 'ai', 'artwork', order), /PDF Compatible/);
  pdf.addPage([158.74, 158.74]);
  const multiPage = Buffer.from(await pdf.save());
  await assert.rejects(() => normalizeUpload(multiPage, 'pdf', 'artwork', order), /single-page/);
});
