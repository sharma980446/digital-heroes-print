import { z } from 'zod';
import type { Configuration, ProductSnapshot } from './catalogue';

const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const position = {
  x: z.number().min(0).max(600),
  y: z.number().min(0).max(600),
  rotation: z.number().min(-180).max(180),
};

export const drawElement = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'), ...position, text: z.string().trim().min(1).max(120),
    font: z.enum(['manrope', 'mono']), size: z.number().min(1).max(150), color,
  }),
  z.object({
    kind: z.literal('logo'), ...position, assetId: z.uuid(),
    width: z.number().min(1).max(600),
  }),
]);

export const designSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('editor'), background: color, ink: color,
    title: z.string().trim().max(80),
    elements: z.array(drawElement).max(20),
  }),
  z.object({ mode: z.literal('upload'), assetId: z.uuid() }),
]);
export type Design = z.infer<typeof designSchema>;
export type DrawElement = z.infer<typeof drawElement>;
export type Runner = { name: string; number: string };

export type PrintAsset = {
  id: string;
  key: string;
  sha256: string;
  width: number;
  height: number;
  kind: 'logo' | 'artwork';
};

export type Snapshot = {
  renderer: 'rgb-v1';
  config: Configuration;
  product: ProductSnapshot;
  design: Design;
  runners: Runner[];
  assets: PrintAsset[];
};

export function defaultDesign(product: ProductSnapshot): Design {
  return { mode: 'editor', title: product.sample, background: product.background, ink: product.ink, elements: [] };
}

export function printSize(config: Configuration, product: ProductSnapshot, ppi = product.ppi) {
  const trimWidth = config.width;
  const trimHeight = config.height;
  const widthMm = trimWidth + product.bleed * 2;
  const heightMm = trimHeight + product.bleed * 2;
  return {
    trimWidth, trimHeight, widthMm, heightMm,
    widthPx: Math.round(widthMm / 25.4 * ppi),
    heightPx: Math.round(heightMm / 25.4 * ppi),
  };
}

export function insideSafeArea(x: number, y: number, width: number, height: number,
  rotation: number, config: Configuration, inset: number) {
  const angle = rotation * Math.PI / 180;
  const halfWidth = (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height) / 2;
  const halfHeight = (Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * height) / 2;
  const epsilon = 0.00001;
  return x - halfWidth + epsilon >= inset && y - halfHeight + epsilon >= inset &&
    x + halfWidth - epsilon <= config.width - inset && y + halfHeight - epsilon <= config.height - inset;
}
