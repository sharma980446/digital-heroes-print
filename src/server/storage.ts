import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { PrintError } from '@/domain/catalogue';
import { dataDirectory, hosted, requiredEnv } from './config';

const bucket = 'press-private';
let cloud: ReturnType<typeof createClient> | undefined;
const objects = () => {
  cloud ??= createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cloud.storage.from(bucket);
};

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function localPath(key: string) {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(key) || key.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('Invalid internal storage key');
  }
  return path.join(dataDirectory(), 'private', ...key.split('/'));
}

export async function writeObject(key: string, bytes: Uint8Array, contentType: string) {
  if (hosted()) {
    const { error } = await objects().upload(key, bytes, { contentType, upsert: false });
    if (error) throw new Error(`Private storage write failed (${error.name})`);
    return;
  }
  const fullPath = localPath(key);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, bytes, { flag: 'wx' });
}

export async function readObject(key: string, sizeLimit?: number) {
  if (hosted()) {
    if (sizeLimit) {
      const info = await objects().info(key);
      if (info.error || !info.data) throw new PrintError('Upload the file before continuing.');
      if (typeof info.data.size !== 'number' || info.data.size > sizeLimit) throw new PrintError('This file exceeds the upload limit.');
    }
    const { data, error } = await objects().download(key);
    if (error || !data) throw new PrintError('The requested file is unavailable.', 404);
    return Buffer.from(await data.arrayBuffer());
  }
  try {
    return await readFile(localPath(key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PrintError('The requested file is unavailable.', 404);
    throw error;
  }
}

export async function signedDownload(key: string, filename: string) {
  if (!hosted()) return null;
  const { data, error } = await objects().createSignedUrl(key, 60, { download: filename });
  if (error || !data) throw new PrintError('The download is temporarily unavailable.', 503);
  return data.signedUrl;
}

export async function signedUpload(key: string) {
  if (!hosted()) return null;
  const { data, error } = await objects().createSignedUploadUrl(key, { upsert: false });
  if (error || !data) throw new PrintError('Could not start the upload.', 503);
  return data.signedUrl;
}
