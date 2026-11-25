import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { seedCatalogue } from '@/domain/catalogue';
import { dataDirectory, hosted, requiredEnv } from './config';

export interface Query {
  query<T extends object>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Database extends Query {
  transaction<T>(work: (tx: Query) => Promise<T>): Promise<T>;
}

const state = globalThis as typeof globalThis & { digitalHeroesDb?: Promise<Database> };

export async function seedProducts(db: Query) {
  for (const product of seedCatalogue) {
    await db.query('insert into printshop.catalogue (id, definition) values ($1, $2) on conflict (id) do nothing',
      [product.id, JSON.stringify(product)]);
  }
}

async function connect(): Promise<Database> {
  if (hosted()) {
    const pool = new Pool({ connectionString: requiredEnv('DATABASE_URL'), max: 4, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000, application_name: 'digital-heroes' });
    pool.on('error', () => console.error('Print database idle connection interrupted'));
    const query = <T extends object>(sql: string, params?: unknown[]) => pool.query<T>(sql, params).then(({ rows }) => rows);
    return {
      query,
      async transaction<T>(work: (tx: Query) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query('begin');
          const result = await work({
            query: <R extends object>(sql: string, params?: unknown[]) => client.query<R>(sql, params).then(({ rows }) => rows),
          });
          await client.query('commit');
          return result;
        } catch (error) {
          await client.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    };
  }

  const directory = dataDirectory();
  await mkdir(directory, { recursive: true });
  const engine = await PGlite.create(path.join(directory, 'postgres'));
  const db: Database = {
    query: <T extends object>(sql: string, params?: unknown[]) => engine.query<T>(sql, params).then(({ rows }) => rows),
    transaction: (work) => engine.transaction((tx) => work({
      query: <T extends object>(sql: string, params?: unknown[]) => tx.query<T>(sql, params).then(({ rows }) => rows),
    })),
  };
  if (!(await db.query<{ ready: string | null }>("select to_regclass('printshop.orders') as ready"))[0].ready) {
    await engine.exec(await readFile(path.join(process.cwd(), 'supabase/migrations/0001_printshop.sql'), 'utf8'));
  }
  const [migration] = await db.query(`select column_name from information_schema.columns
    where table_schema='printshop' and table_name='proofs' and column_name='hash_format'`);
  if (!migration) {
    await engine.exec(await readFile(path.join(process.cwd(), 'supabase/migrations/0002_canonical_proofs_and_archives.sql'), 'utf8'));
  }
  await seedProducts(db);
  return db;
}

export function database() {
  state.digitalHeroesDb ??= connect().catch((error: unknown) => {
    delete state.digitalHeroesDb;
    throw error;
  });
  return state.digitalHeroesDb;
}
