import { z } from 'zod';
import { hosted, requiredEnv } from '../src/server/config';
import { database, seedProducts } from '../src/server/db';

async function main() {
  if (!hosted()) throw new Error('Set APP_MODE=hosted and connect the new Supabase database before seeding.');
  const staffEmail = z.email().parse(requiredEnv('SEED_STAFF_EMAIL')).toLowerCase();
  const db = await database();
  await db.transaction(async (tx) => {
    const [reviewer] = await tx.query<{ id: string }>('select id from auth.users where lower(email)=$1 and email_confirmed_at is not null', [staffEmail]);
    if (!reviewer) throw new Error('Create and confirm the staff user in the dedicated Supabase Auth project first.');
    await seedProducts(tx);
    await tx.query(`insert into printshop.accounts (id,email,display_name,role) values ($1,$2,'Print staff','staff')
      on conflict(id) do update set role='staff',disabled=false,email=excluded.email`, [reviewer.id, staffEmail]);
  });
  console.log('Seeded catalogue and granted staff access to the confirmed review account.');
}

void main().then(() => { process.exitCode = 0; }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Setup failed.');
  process.exitCode = 1;
});
