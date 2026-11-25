import { z } from 'zod';

export const ORDER_CURRENCY = 'INR' as const;
const minimumCheckoutMinor = 50;

export const productSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  title: z.string().trim().min(2).max(64),
  description: z.string().trim().min(2).max(180),
  referenceWidth: z.number().int().min(10).max(300),
  referenceHeight: z.number().int().min(10).max(300),
  bleed: z.number().int().min(0).max(8),
  safeInset: z.number().min(0).max(4),
  ppi: z.number().int().min(150).max(450),
  basePriceMinor: z.number().int().min(1).max(20000),
  taxBps: z.number().int().min(0).max(3000),
  revision: z.number().int().min(1),
  background: z.string().regex(/^#[0-9a-f]{6}$/i),
  ink: z.string().regex(/^#[0-9a-f]{6}$/i),
  sample: z.string().min(1).max(60),
  personalized: z.boolean(),
  active: z.boolean(),
  materials: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    title: z.string().trim().min(1).max(48),
    multiplierBps: z.number().int().min(1000).max(40000),
  })).min(1).max(12).refine((materials) => new Set(materials.map(({ id }) => id)).size === materials.length),
});

export type Product = z.infer<typeof productSchema>;
export type ProductSnapshot = Omit<Product, 'basePriceMinor' | 'taxBps'>;

const defaults = {
  revision: 1,
  ppi: 300,
  taxBps: 2000,
  active: true,
  personalized: false,
};

export const seedCatalogue: Product[] = [
  { ...defaults, id: 'stickers', title: 'Labels & stickers', description: 'Branded labels, packaging seals and decals.', referenceWidth: 50, referenceHeight: 50, bleed: 3, safeInset: 3, basePriceMinor: 100, background: '#fce9b6', ink: '#232c2a', sample: 'Morning Club',
    materials: [{ id: 'matte', title: 'Matte vinyl', multiplierBps: 10000 }, { id: 'gloss', title: 'Gloss vinyl', multiplierBps: 12000 }] },
  { ...defaults, id: 'race', title: 'Race & event numbers', description: 'One bib design, a different runner on every copy.', referenceWidth: 200, referenceHeight: 150, bleed: 3, safeInset: 4, basePriceMinor: 200, background: '#f7f9ec', ink: '#20352a', sample: 'City Loop Run', personalized: true,
    materials: [{ id: 'synthetic', title: 'Synthetic paper', multiplierBps: 10000 }] },
  { ...defaults, id: 'mtb', title: 'MTB boards', description: 'Number boards for the start line and the trail.', referenceWidth: 200, referenceHeight: 150, bleed: 3, safeInset: 4, basePriceMinor: 500, background: '#e0eadf', ink: '#263e34', sample: 'Trail Series',
    materials: [{ id: 'rigid', title: 'Rigid plastic', multiplierBps: 10000 }] },
  { ...defaults, id: 'stamps', title: 'Stamps', description: 'A repeatable mark for paperwork and packaging.', referenceWidth: 50, referenceHeight: 20, bleed: 0, safeInset: 2, basePriceMinor: 800, background: '#f7f4ee', ink: '#232321', sample: 'Packed today',
    materials: [{ id: 'rubber', title: 'Rubber', multiplierBps: 10000 }] },
  { ...defaults, id: 'trophies', title: 'Trophies', description: 'Personalised plates for awards and milestones.', referenceWidth: 70, referenceHeight: 30, bleed: 0, safeInset: 2, basePriceMinor: 1200, background: '#e7d8b3', ink: '#322d1d', sample: 'First Place',
    materials: [{ id: 'aluminium', title: 'Aluminium plate', multiplierBps: 10000 }] },
  { ...defaults, id: 'laser', title: 'Laser-cut work', description: 'Artwork for engraved tags and small signage.', referenceWidth: 80, referenceHeight: 40, bleed: 0, safeInset: 2, basePriceMinor: 400, background: '#edd9c5', ink: '#3f2e28', sample: 'Field Notes',
    materials: [{ id: 'plywood', title: 'Plywood', multiplierBps: 10000 }] },
];

export const configurationSchema = z.object({
  productId: productSchema.shape.id,
  material: z.string(),
  orientation: z.enum(['landscape', 'portrait']),
  width: z.number().int().positive().max(600),
  height: z.number().int().positive().max(600),
  quantity: z.number().int().min(1).max(1000),
});

export type Configuration = z.infer<typeof configurationSchema>;

export class PrintError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = 'PrintError';
  }
}

export function referenceSize(product: Product, orientation: Configuration['orientation']) {
  const short = Math.min(product.referenceWidth, product.referenceHeight);
  const long = Math.max(product.referenceWidth, product.referenceHeight);
  return orientation === 'landscape' ? [long, short] : [short, long];
}

export function defaultConfiguration(product: Product): Configuration {
  const [width, height] = referenceSize(product, 'landscape');
  return { productId: product.id, material: product.materials[0].id, orientation: 'landscape',
    width, height, quantity: product.personalized ? 3 : 100 };
}

function roundHalfUp(numerator: bigint, denominator: bigint) {
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

export function quoteProduct(product: Product, input: Configuration) {
  const config = configurationSchema.parse(input);
  if (!product.active || config.productId !== product.id) throw new PrintError('This product is unavailable.');
  const material = product.materials.find(({ id }) => id === config.material);
  if (!material) throw new PrintError('Choose an available material.');
  const [width, height] = referenceSize(product, config.orientation);
  const ranges = [Math.ceil(width / 2), width * 2, Math.ceil(height / 2), height * 2];
  if (config.width < ranges[0] || config.width > ranges[1] || config.height < ranges[2] || config.height > ranges[3]) {
    throw new PrintError(`Enter a width of ${ranges[0]}–${ranges[1]} mm and a height of ${ranges[2]}–${ranges[3]} mm.`);
  }
  if ((config.width > config.height && config.orientation === 'portrait') ||
      (config.height > config.width && config.orientation === 'landscape')) {
    throw new PrintError('Width and height must match the selected orientation.');
  }
  const pixelWidth = Math.round((config.width + product.bleed * 2) / 25.4 * product.ppi);
  const pixelHeight = Math.round((config.height + product.bleed * 2) / 25.4 * product.ppi);
  if (pixelWidth * pixelHeight > 25_000_000) {
    throw new PrintError('This print profile cannot render that size. Choose smaller dimensions.');
  }

  const { quantity } = config;
  const discountBps = quantity >= 500 ? 1500 : quantity >= 100 ? 1000 : 0;
  const lineNumerator = BigInt(product.basePriceMinor) * BigInt(config.width * config.height) *
    BigInt(material.multiplierBps) * BigInt(quantity);
  const lineDenominator = BigInt(width * height) * 10000n;
  const beforeDiscount = roundHalfUp(lineNumerator, lineDenominator);
  const subtotal = roundHalfUp(lineNumerator * BigInt(10000 - discountBps), lineDenominator * 10000n);
  const tax = roundHalfUp(BigInt(subtotal) * BigInt(product.taxBps), 10000n);
  const total = subtotal + tax;
  if (total < minimumCheckoutMinor) {
    throw new PrintError(`The minimum order total is ${money(minimumCheckoutMinor)}. Increase the quantity or choose a larger size.`);
  }
  return {
    currency: ORDER_CURRENCY, basePriceMinor: product.basePriceMinor,
    referenceAreaMm2: width * height, materialMultiplierBps: material.multiplierBps,
    material: material.title, discountBps, taxBps: product.taxBps, beforeDiscount,
    discount: beforeDiscount - subtotal, subtotal, tax, total,
    unitAverage: roundHalfUp(BigInt(total), BigInt(quantity)),
  };
}

export type Quote = ReturnType<typeof quoteProduct>;
export const storedCurrencies = [ORDER_CURRENCY, 'GBP'] as const;
export type OrderCurrency = (typeof storedCurrencies)[number];
export type PriceSnapshot = Omit<Quote, 'currency' | 'basePriceMinor' | 'taxBps'> & { currency: OrderCurrency };

const currencyFormats = new Map([
  [ORDER_CURRENCY, new Intl.NumberFormat('en-IN', { style: 'currency', currency: ORDER_CURRENCY })],
  ['GBP', new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })],
]);

export function money(amountMinor: number, currency: string = ORDER_CURRENCY) {
  const format = currencyFormats.get(currency);
  return format ? format.format(amountMinor / 100) : `${currency} ${amountMinor} minor units`;
}

export const taxName = (currency: OrderCurrency) => currency === ORDER_CURRENCY ? 'Tax' : 'VAT';
