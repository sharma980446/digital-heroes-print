import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { defaultConfiguration, seedCatalogue } from '../src/domain/catalogue';
import { defaultDesign, type Snapshot } from '../src/domain/design';
import { renderPng } from '../src/server/render';

async function main() {
  const directory = 'public/samples/artwork';
  await mkdir(directory, { recursive: true });
  for (const product of seedCatalogue) {
    const snapshot: Snapshot = {
      renderer: 'rgb-v1', config: defaultConfiguration(product), product, design: defaultDesign(product),
      runners: product.personalized ? [{ name: 'Maya Patel', number: '007' }] : [],
      assets: [],
    };
    const proof = await renderPng(snapshot, 0, new Map(), true);
    await sharp(proof).resize({ width: 480, height: 320, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 87 }).toFile(path.join(directory, `${product.id}.webp`));
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
