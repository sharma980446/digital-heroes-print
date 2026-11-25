import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import sharp from 'sharp';

const base = process.env.DH_BROWSER_ORIGIN ?? 'http://127.0.0.1:3000';
const output = path.resolve('test-results/browser');
const credentials = { name: 'Maya Patel', email: `reviewer-${Date.now()}@example.test`, password: 'Local-Customer-7!' };
const staffCredentials = { email: 'staff@print.example', password: 'PressRoom-Local-42!' };
const route = (name: string) => `${base}/api/print/${name}`;

async function auth(page: Page, values: { email: string; password: string; name?: string }) {
  await page.locator('.auth-card').waitFor();
  if (values.name) {
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(values.name);
  }
  await page.getByLabel('Email', { exact: true }).fill(values.email);
  await page.getByLabel('Password').fill(values.password);
  await page.locator('.auth-card .button.full').click();
}

async function post<T>(context: BrowserContext, endpoint: string, data: object) {
  const response = await context.request.post(route(endpoint), { data, headers: { Origin: base } });
  const body = await response.json();
  assert.ok(response.ok(), `${endpoint} failed with ${response.status()}: ${JSON.stringify(body)}`);
  return body as T;
}

async function fitsViewport(page: Page, screen: string) {
  const available = await page.evaluate(() => ({ screen: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(available.document <= available.screen + 1, `${screen} overflows: ${JSON.stringify(available)}`);
}

async function productionFile(context: BrowserContext, id: string, row: number, format: string) {
  const result = await context.request.get(route(`orders/${id}/files/${row}/${format}`));
  assert.ok(result.ok(), `Expected ${format} download, status ${result.status()}`);
  return result.body();
}

async function main() {
  const opened = new URL(base);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(opened.hostname), 'This browser test requires a local demo.');
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.DH_CHROMIUM_CHANNEL || 'msedge', headless: true });
  try {
    const mobile = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const phone = await mobile.newPage();
    const staff = await desktop.newPage();
    const browserErrors: string[] = [];
    for (const page of [phone, staff]) page.on('pageerror', (e) => browserErrors.push(e.message));
    for (const page of [phone, staff]) page.setDefaultTimeout(25000);

    await staff.goto(base);
    await staff.evaluate(() => document.fonts.ready.then(() => undefined));
    await fitsViewport(staff, '1440 px storefront');
    await staff.screenshot({ path: path.join(output, 'storefront-desktop.png'), fullPage: true });
    await phone.goto(base);
    await phone.evaluate(() => document.fonts.ready.then(() => undefined));
    await fitsViewport(phone, '360 px storefront');
    await phone.screenshot({ path: path.join(output, 'storefront-phone.png'), fullPage: true });
    assert.equal(await phone.locator('.product-card').count(), 6);
    await phone.getByLabel('Filter by product', { exact: false }).selectOption('race');
    assert.equal(await phone.locator('.gallery-sample').count(), 1);
    await phone.locator('.product-card').filter({ hasText: 'Race & event numbers' }).click();
    await phone.getByLabel('Width (mm)').fill('210');
    await phone.getByRole('button', { name: 'Sign in to order' }).click();
    await auth(phone, credentials);
    await phone.waitForURL('**/products/race');
    assert.equal(await phone.getByLabel('Width (mm)').inputValue(), '210');
    await phone.getByLabel('Width (mm)').fill('200');
    await phone.getByRole('button', { name: 'Create order' }).click();
    await phone.waitForURL('**/orders/*');
    const raceUrl = new URL(phone.url());
    const raceId = raceUrl.pathname.split('/').at(-1)!;
    await phone.getByLabel('Upload runner CSV').setInputFiles('public/samples/runners.csv');
    await phone.getByRole('button', { name: 'Publish proof' }).click();
    await phone.getByRole('button', { name: 'Approve v1' }).waitFor();
    const first = await (await mobile.request.get(route(`orders/${raceId}`))).json();
    assert.equal(first.proofs[0].names[0].number, '007');
    await phone.getByLabel('Runner', { exact: true }).selectOption('2');
    await phone.getByRole('img', { name: /Alexandra Fernanda Rodrigues/ }).waitFor();
    await fitsViewport(phone, '360 px proof');
    await phone.screenshot({ path: path.join(output, 'race-proof-phone.png'), fullPage: true });

    await staff.goto(`${base}/account`);
    await auth(staff, staffCredentials);
    await staff.getByRole('link', { name: 'Open production console' }).waitFor();
    assert.equal((await desktop.request.get(route(`orders/${raceId}/files/1/pdf`))).status(), 409);
    const oldTab = await mobile.newPage();
    await oldTab.goto(raceUrl.href);
    await oldTab.getByRole('button', { name: 'Approve v1' }).waitFor();
    await phone.getByRole('button', { name: 'Request changes' }).click();
    await phone.getByLabel('What should change?').fill('Change the event title to City Loop Finals.');
    await phone.getByRole('button', { name: 'Send change request' }).click();
    await phone.getByText('Changes requested. Change the event title', { exact: false }).waitFor();
    await staff.goto(raceUrl.href);
    await staff.getByRole('button', { name: 'Revise artwork' }).click();
    await staff.getByLabel('Event title').fill('City Loop Finals');
    await staff.getByRole('button', { name: 'Publish proof' }).click();
    await staff.getByLabel('Version', { exact: true }).waitFor();
    const stale = await mobile.request.post(route(`orders/${raceId}/approve`), {
      data: { proofId: first.proofs[0].id, revision: first.order.revision }, headers: { Origin: base },
    });
    assert.equal(stale.status(), 409);
    await oldTab.getByRole('button', { name: 'Approve v1' }).click();
    await oldTab.getByRole('alert').filter({ hasText: 'This order changed' }).waitFor();
    await oldTab.getByRole('button', { name: 'Approve v2' }).waitFor();
    await oldTab.close();
    await phone.reload();
    await phone.getByRole('button', { name: 'Approve v2' }).click();
    await phone.getByRole('button', { name: 'Continue to test checkout' }).click();
    await phone.getByRole('button', { name: 'Cancel checkout' }).click();
    await phone.getByRole('button', { name: 'Continue to test checkout' }).click();
    await phone.getByRole('button', { name: 'Confirm test payment' }).click();
    await phone.getByRole('link', { name: 'Download receipt' }).waitFor();
    await staff.reload();
    await staff.getByRole('link', { name: 'Download batch ZIP' }).waitFor({ timeout: 45000 });
    const batch = await productionFile(desktop, raceId, 0, 'zip');
    assert.equal(Object.keys(unzipSync(batch)).length, 6);
    await writeFile(path.join(output, 'race-batch.zip'), batch);
    assert.equal((await mobile.request.get(route(`orders/${raceId}/files/1/pdf`))).status(), 403);
    const outsider = await browser.newContext();
    await post(outsider, 'auth/signup', { ...credentials, email: `other-${credentials.email}` });
    assert.equal((await outsider.request.get(route(`orders/${raceId}`))).status(), 404);
    assert.equal((await outsider.request.get(route(`orders/${raceId}/proof/${first.proofs[0].id}`))).status(), 404);
    await outsider.close();
    await fitsViewport(staff, '1440 px production order');
    await staff.screenshot({ path: path.join(output, 'race-production.png'), fullPage: true });
    await staff.getByRole('button', { name: 'Start production' }).click();
    await staff.getByRole('button', { name: 'Mark completed' }).click();
    await staff.locator('.order-status').getByText('Completed').waitFor();
    await staff.getByRole('link', { name: 'Production console', exact: true }).click();
    await staff.getByRole('button', { name: 'Archive', exact: true }).click();
    await staff.getByLabel('Customer or job').fill(`DH${first.order.number}`);
    await staff.getByLabel('Product family', { exact: false }).selectOption('race');
    await staff.getByRole('button', { name: 'Apply filters' }).click();
    await staff.locator('.order-row').filter({ hasText: `DH${first.order.number}` }).waitFor();
    await staff.getByRole('button', { name: 'Reports', exact: true }).click();
    await staff.getByRole('row', { name: /Race & event numbers/ }).waitFor();
    const accounting = await desktop.request.get(route('staff/export'));
    assert.equal(accounting.status(), 200);
    assert.match(await accounting.text(), new RegExp(`"DH${first.order.number}","[^\\n]+","7\\.20","INR",`));
    await phone.reload();
    await phone.getByRole('button', { name: 'Reorder design' }).click();
    await phone.waitForURL((url) => url.pathname.startsWith('/orders/') && url.pathname !== raceUrl.pathname);
    await phone.getByText('Approval carried over from', { exact: false }).waitFor();

    await phone.goto(`${base}/products/stickers`);
    await phone.locator('.quote-value').getByText('₹108.00', { exact: false }).waitFor();
    await fitsViewport(phone, '360 px sticker quote');
    await phone.getByRole('button', { name: 'Create order' }).click();
    await phone.waitForURL('**/orders/*');
    const stickerUrl = new URL(phone.url());
    const stickerId = stickerUrl.pathname.split('/').at(-1)!;
    const logo = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#20352a' } }).png().toBuffer();
    await phone.getByLabel('Add PNG logo').setInputFiles({ name: 'cafe-logo.png', mimeType: 'image/png', buffer: logo });
    await phone.getByLabel('Vertical centre (mm)').fill('12');
    await phone.getByLabel('Rotation (°)').fill('20');
    await phone.getByText('Logo 1 crosses the safe area', { exact: false }).waitFor();
    await phone.getByLabel('Vertical centre (mm)').fill('14');
    await phone.getByLabel('Logo width (mm)').fill('12');
    await phone.getByRole('button', { name: 'Publish proof' }).click();
    await phone.getByRole('button', { name: 'Approve v1' }).click();
    await phone.getByRole('button', { name: 'Continue to test checkout' }).click();
    await phone.getByText('Simulated payment of ₹108.00.', { exact: true }).waitFor();
    await phone.getByRole('button', { name: 'Confirm test payment' }).click();
    await phone.getByRole('link', { name: 'Download receipt' }).waitFor();
    await staff.goto(stickerUrl.href);
    await staff.getByRole('link', { name: 'Download PNG' }).waitFor({ timeout: 45000 });
    const png = await productionFile(desktop, stickerId, 1, 'png');
    const metadata = await sharp(png).metadata();
    assert.deepEqual([metadata.width, metadata.height, metadata.density], [661, 661, 300]);
    const pdf = await productionFile(desktop, stickerId, 1, 'pdf');
    const page = (await PDFDocument.load(pdf)).getPage(0);
    assert.ok(Math.abs(page.getTrimBox().width * 25.4 / 72 - 50) < 1e-6);
    assert.ok(Math.abs(page.getBleedBox().width * 25.4 / 72 - 56) < 1e-6);
    await writeFile(path.join(output, 'sticker.png'), png);
    await writeFile(path.join(output, 'sticker.pdf'), pdf);
    const receipt = await mobile.request.get(route(`orders/${stickerId}/receipt`));
    assert.equal(receipt.status(), 200);
    assert.equal(receipt.headers()['content-type'], 'application/pdf');
    await writeFile(path.join(output, 'sticker-receipt.pdf'), await receipt.body());
    assert.deepEqual(browserErrors, []);
    console.log(`Browser acceptance passed. Race ${first.order.number} and sticker ${(await (await mobile.request.get(route(`orders/${stickerId}`))).json()).order.number}. Artifacts saved to test-results/browser.`);
  } finally {
    await browser.close();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
