import path from 'node:path';
import { PrintError } from '@/domain/catalogue';

export const hosted = () => process.env.VERCEL === '1' || process.env.APP_MODE === 'hosted';
export const dataDirectory = () => path.resolve(/*turbopackIgnore: true*/ process.env.DH_DATA_DIR || '.data');

export function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration ${name}`);
  return value;
}

export function appOrigin() {
  const url = new URL(hosted() ? requiredEnv('APP_ORIGIN') : (process.env.APP_ORIGIN || 'http://127.0.0.1:3000'));
  if (hosted() && url.protocol !== 'https:') throw new Error('Hosted APP_ORIGIN must use HTTPS.');
  if (!hosted() && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Demo mode is limited to loopback.');
  }
  return url.origin;
}

export function checkOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin !== appOrigin()) throw new PrintError('Open the store at its configured address and try again.', 403);
}
