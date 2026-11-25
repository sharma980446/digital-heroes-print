import path from 'node:path';
import { openSync, type Font } from 'fontkit';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { PrintError } from '@/domain/catalogue';
import { insideSafeArea, printSize, type Snapshot } from '@/domain/design';
import { readObject, sha256 } from './storage';

const fontFiles = {
  manrope: ['manrope-latin-wght-normal.woff2', 'manrope-latin-ext-wght-normal.woff2'],
  mono: ['ibm-plex-mono-latin-400-normal.woff2', 'ibm-plex-mono-latin-ext-400-normal.woff2'],
  bib: ['ibm-plex-mono-latin-700-normal.woff2'],
};
const fonts = new Map<string, Font>();
const points = (mm: number) => mm / 25.4 * 72;
const num = (n: number) => Number(n.toFixed(5));

function fontAt(file: string) {
  let font = fonts.get(file);
  if (!font) {
    const opened = openSync(path.join(process.cwd(), 'assets/fonts', file));
    if (!('layout' in opened)) throw new Error('Expected a single print font.');
    font = opened;
    fonts.set(file, font);
  }
  return font;
}

function prepareText(text: string, family: keyof typeof fontFiles, label: string) {
  const candidates = fontFiles[family].map(fontAt);
  const chars = [...text];
  const primary = candidates.find((font) => chars.every((char) => font.hasGlyphForCodePoint(char.codePointAt(0)!)));
  const runs: { font: Font; text: string }[] = [];
  for (const char of chars) {
    const font = primary ?? candidates.find((item) => item.hasGlyphForCodePoint(char.codePointAt(0)!));
    if (!font) throw new PrintError(`${label} contains a character unavailable in this font. Change the text or font.`);
    const current = runs.at(-1);
    if (current?.font === font) current.text += char;
    else runs.push({ font, text: char });
  }
  return runs.flatMap(({ text: content, font }) => {
    const group = font.layout(content);
    return group.glyphs.map((glyph, index) => ({
      outline: glyph.path.toSVG(), box: glyph.bbox, units: font.unitsPerEm, ...group.positions[index],
    }));
  });
}

function bounds(glyphs: ReturnType<typeof prepareText>, size: number, tracking = 0) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  let cursor = 0;
  const items = glyphs.map(({ outline, box, units, xOffset, yOffset, xAdvance }) => {
    const scale = size / units;
    const x = cursor + xOffset * scale;
    const y = -yOffset * scale;
    if (outline) {
      left = Math.min(left, x + box.minX * scale);
      right = Math.max(right, x + box.maxX * scale);
      top = Math.min(top, y - box.maxY * scale);
      bottom = Math.max(bottom, y - box.minY * scale);
    }
    cursor += xAdvance * scale + tracking;
    return { outline, x, y, scale };
  });
  if (!Number.isFinite(left)) throw new PrintError('Enter visible text.');
  return { width: right - left, height: bottom - top, x: (left + right) / 2, y: (top + bottom) / 2, items };
}

function placeText(shape: ReturnType<typeof bounds>, x: number, y: number, rotation: number, color: string) {
  const glyphs = shape.items.filter(({ outline }) => outline).map(({ outline, x, y, scale }) =>
    `<path d="${outline}" transform="translate(${num(x)} ${num(y)}) scale(${num(scale)} ${num(-scale)})"/>`,
  ).join('');
  return `<g fill="${color}" transform="translate(${num(x)} ${num(y)}) rotate(${rotation}) translate(${num(-shape.x)} ${num(-shape.y)})">${glyphs}</g>`;
}

function fitText(text: string, font: keyof typeof fontFiles, label: string, x: number, y: number,
  width: number, height: number, maximum: number, minimum: number, tracking: number, color: string) {
  const glyphs = prepareText(text, font, label);
  const check = (size: number) => bounds(glyphs, size, tracking);
  const natural = check(maximum);
  const fits = (shape: typeof natural) => shape.width <= width && shape.height <= height;
  if (fits(natural)) return placeText(natural, x, y, 0, color);
  const base = check(minimum);
  if (!fits(base)) throw new PrintError(`${label} will not fit at the minimum size. Shorten the text or change the print size.`);
  let low = minimum;
  let high = maximum;
  for (let i = 0; i < 12; i++) {
    const middle = (low + high) / 2;
    if (fits(check(middle))) low = middle;
    else high = middle;
  }
  return placeText(check(low), x, y, 0, color);
}

function layout(snap: Snapshot, row: number, images?: Map<string, Buffer>) {
  const { config, product, design } = snap;
  const { width: w, height: h } = config;
  const { bleed, safeInset } = product;
  const size = printSize(config, product);
  const image = (id: string, kind: 'logo' | 'artwork') => {
    const asset = snap.assets.find((item) => item.id === id && item.kind === kind);
    if (!asset) throw new PrintError('Upload this image again before publishing.');
    return { ...asset, data: images?.get(id)?.toString('base64') ?? '' };
  };
  if (design.mode === 'upload') {
    if (product.personalized) throw new PrintError('The race template needs its editable name and number fields.');
    const artwork = image(design.assetId, 'artwork');
    if (artwork.width < size.widthPx || artwork.height < size.heightPx ||
      Math.abs((artwork.width / artwork.height) / (size.widthPx / size.heightPx) - 1) > .02) {
      throw new PrintError('Upload artwork at the new print size, including bleed.');
    }
    return `<image x="${-bleed}" y="${-bleed}" width="${size.widthMm}" height="${size.heightMm}" preserveAspectRatio="none" href="data:image/png;base64,${artwork.data}"/>`;
  }
  const runner = snap.runners[row];
  if (product.personalized && !runner) throw new PrintError('Select a valid runner.');
  let body = `<rect x="${-bleed}" y="${-bleed}" width="${size.widthMm}" height="${size.heightMm}" fill="${design.background}"/>`;
  const safe = w - safeInset * 2;
  if (runner) {
    const textWidth = Math.min(safe, w * .86);
    body += `<rect x="${-bleed}" y="${-bleed}" width="${size.widthMm}" height="${h * .20 + bleed}" fill="${design.ink}"/>`;
    if (design.title) body += fitText(design.title, 'mono', 'Event title', w / 2, h * .11, textWidth, h * .08,
      h * .083, h * .045, .13, design.background);
    body += fitText(runner.number, 'bib', `Row ${row + 1}, bib number`, w / 2, h * .50, textWidth, h * .42,
      h * .5, h * .20, .08, design.ink);
    body += `<path d="M ${safeInset} ${h * .73} H ${w - safeInset}" stroke="${design.ink}" stroke-width="${h * .006}"/>`;
    body += fitText(runner.name, 'mono', `Row ${row + 1}, name`, w / 2, h * .85, textWidth, h * .13,
      h * .105, h * .053, .13, design.ink);
  } else if (design.title) {
    body += fitText(design.title, 'mono', 'Design title', w / 2, h / 2, safe * .95, (h - safeInset * 2) * .7,
      Math.min(w, h) * .19, Math.min(w, h) * .085, .05, design.ink);
  }
  if (!runner && !design.title && !design.elements.length) throw new PrintError('Add text or an image to the design.');
  for (const [index, element] of design.elements.entries()) {
    const { x, y, rotation } = element;
    if (element.kind === 'text') {
      const shape = bounds(prepareText(element.text, element.font, `Text ${index + 1}`), element.size);
      if (!insideSafeArea(x, y, shape.width, shape.height, rotation, config, safeInset)) {
        throw new PrintError(`Text ${index + 1} crosses the safe area. Move it inward or reduce its size.`);
      }
      body += placeText(shape, x, y, rotation, element.color);
    } else {
      const logo = image(element.assetId, 'logo');
      const height = logo.height / logo.width * element.width;
      if (!insideSafeArea(x, y, element.width, height, rotation, config, safeInset)) {
        throw new PrintError(`Logo ${index + 1} crosses the safe area. Move it inward or reduce its size.`);
      }
      const requiredWidth = Math.round(element.width / 25.4 * product.ppi);
      if (logo.width < requiredWidth) throw new PrintError(`Logo ${index + 1} needs at least ${requiredWidth} pixels of width at this size.`);
      body += `<image x="${num(-element.width / 2)}" y="${num(-height / 2)}" width="${element.width}" height="${num(height)}" transform="translate(${x} ${y}) rotate(${rotation})" href="data:image/png;base64,${logo.data}"/>`;
    }
  }
  return body;
}

export function validateArtwork(snapshot: Snapshot) {
  const count = snapshot.runners.length || 1;
  for (let row = 0; row < count; row++) layout(snapshot, row);
}

export async function artworkImages(snap: Snapshot) {
  return new Map(await Promise.all(snap.assets.map(async ({ id, key, sha256: expected }) => {
    const file = await readObject(key);
    if (sha256(file) !== expected) throw new Error('A frozen artwork asset failed its integrity check.');
    return [id, file] as const;
  })));
}

export async function renderPng(snap: Snapshot, row: number, assets: Map<string, Buffer>, preview = false, guides = false) {
  if (snap.renderer !== 'rgb-v1') throw new Error('The required artwork renderer is unavailable.');
  const ppi = preview ? Math.min(110, Math.round(1100 * 25.4 / Math.max(snap.config.width, snap.config.height))) : snap.product.ppi;
  const { widthPx, heightPx, widthMm, heightMm, trimWidth, trimHeight } = printSize(snap.config, snap.product, ppi);
  const { bleed, safeInset } = snap.product;
  const dashed = guides ? `<g fill="none" stroke="#b84320" stroke-width=".45">
    <rect x="0" y="0" width="${trimWidth}" height="${trimHeight}"/>
    <rect x="${safeInset}" y="${safeInset}" width="${trimWidth - safeInset * 2}" height="${trimHeight - safeInset * 2}" stroke-dasharray="2 1"/>
    </g>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="${-bleed} ${-bleed} ${widthMm} ${heightMm}" preserveAspectRatio="none">${layout(snap, row, assets)}${dashed}</svg>`;
  return sharp(Buffer.from(svg), { limitInputPixels: 25_000_000 }).png().withMetadata({ density: ppi }).toBuffer();
}

export async function renderPdf(snap: Snapshot, png: Uint8Array, title: string) {
  const { trimWidth, trimHeight, widthMm, heightMm } = printSize(snap.config, snap.product);
  const bleed = points(snap.product.bleed);
  const width = points(widthMm);
  const height = points(heightMm);
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('Digital Heroes Print');
  const page = pdf.addPage([width, height]);
  page.setTrimBox(bleed, bleed, points(trimWidth), points(trimHeight));
  page.setBleedBox(0, 0, width, height);
  page.drawImage(await pdf.embedPng(png), { x: 0, y: 0, width, height });
  return pdf.save();
}
