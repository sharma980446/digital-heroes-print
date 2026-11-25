import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { PrintError } from '@/domain/catalogue';
import { accountReturn } from '@/domain/navigation';
import { appOrigin, hosted, requiredEnv } from './config';
import { database } from './db';

const deriveKey = promisify(scrypt);
const cookieName = 'dh_demo_session';
const sessionSeconds = 60 * 60 * 24 * 7;
const staffDemo = { id: '2c89e25e-9cb9-4530-bf17-2f1164264b0b', email: 'staff@print.example', password: 'PressRoom-Local-42!' };

export type Account = {
  id: string;
  email: string;
  display_name: string;
  role: 'customer' | 'staff';
  disabled: boolean;
};

export const authInput = z.object({
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(2).max(80).optional(),
  next: z.string().max(100).optional(),
});

async function supabase() {
  const jar = await cookies();
  return createServerClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_PUBLISHABLE_KEY'), {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (updates) => updates.forEach(({ name, value, options }) => jar.set(name, value, {
        ...options, secure: true, httpOnly: true, sameSite: 'lax',
      })),
    },
  });
}

async function passwordHash(password: string, salt: string) {
  return (await deriveKey(password, salt, 64)) as Buffer;
}

async function newSecret(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await passwordHash(password, salt)).toString('hex')}`;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function setDemoSession(id: string) {
  const db = await database();
  const token = randomBytes(32).toString('base64url');
  await db.query("insert into printshop.demo_sessions values ($1, $2, now() + interval '7 days')", [hashToken(token), id]);
  (await cookies()).set(cookieName, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: sessionSeconds });
}

export async function authenticate(input: z.infer<typeof authInput>, create: boolean) {
  if (create && !input.name) throw new PrintError('Enter your name.');
  if (hosted()) {
    const auth = (await supabase()).auth;
    if (create) {
      const redirect = new URL('/api/print/auth/confirm', appOrigin());
      redirect.searchParams.set('next', accountReturn(input.next));
      const { data, error } = await auth.signUp({ email: input.email, password: input.password,
        options: { data: { full_name: input.name }, emailRedirectTo: redirect.href } });
      if (error) {
        if (error.status === undefined || error.status >= 500 ||
            error.code === 'email_address_not_authorized' || error.code === 'over_email_send_rate_limit') {
          console.warn('Supabase Auth signup failed', { status: error.status, code: error.code });
        }
        if (error.status === 429) throw new PrintError('Too many attempts. Try again later.', 429);
        throw new PrintError('Could not register this account.');
      }
      return { confirmationRequired: !data.session };
    }
    const { error } = await auth.signInWithPassword({ email: input.email, password: input.password });
    if (error) throw new PrintError('Check your email, password and confirmation status.', 401);
    return { confirmationRequired: false };
  }

  const db = await database();
  if (input.email === staffDemo.email) {
    if (create) throw new PrintError('This email is reserved.');
    const [existing] = await db.query<{ id: string }>('select id from printshop.accounts where id = $1', [staffDemo.id]);
    if (!existing) {
      const secret = await newSecret(staffDemo.password);
      await db.transaction(async (tx) => {
        await tx.query("insert into printshop.accounts (id, email, display_name, role) values ($1, $2, 'Print staff', 'staff') on conflict do nothing",
          [staffDemo.id, staffDemo.email]);
        await tx.query('insert into printshop.demo_credentials values ($1, $2) on conflict do nothing', [staffDemo.id, secret]);
      });
    }
  }
  if (create) {
    const id = randomUUID();
    const secret = await newSecret(input.password);
    await db.transaction(async (tx) => {
      const [account] = await tx.query<{ id: string }>(
        'insert into printshop.accounts (id, email, display_name) values ($1, $2, $3) on conflict do nothing returning id',
        [id, input.email, input.name]);
      if (!account) throw new PrintError('Account already exists. Sign in to continue.', 409);
      await tx.query('insert into printshop.demo_credentials values ($1, $2)', [id, secret]);
    });
    await setDemoSession(id);
  } else {
    const [account] = await db.query<Account & { secret: string }>(
      'select a.*, c.secret from printshop.accounts a join printshop.demo_credentials c on c.account_id = a.id where a.email = $1', [input.email]);
    const [salt, reference] = account?.secret.split(':') ?? ['demo-delay-salt', '00'.repeat(64)];
    const candidate = await passwordHash(input.password, salt);
    if (!timingSafeEqual(candidate, Buffer.from(reference, 'hex')) || !account || account.disabled) {
      throw new PrintError('Check your email and password.', 401);
    }
    await setDemoSession(account.id);
  }
  return { confirmationRequired: false };
}

export async function confirmSignup(url: URL) {
  if (!hosted()) return false;
  const auth = (await supabase()).auth;
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  if (code) return !(await auth.exchangeCodeForSession(code)).error;
  if (tokenHash) return !(await auth.verifyOtp({ token_hash: tokenHash, type: 'email' })).error;
  return false;
}

export async function accountForRequest(): Promise<Account | null> {
  if (hosted()) {
    const { data } = await (await supabase()).auth.getUser();
    const user = data.user;
    if (!user?.email) return null;
    const name = typeof user.user_metadata.full_name === 'string'
      ? user.user_metadata.full_name.trim().slice(0, 80) : '';
    const [account] = await (await database()).query<Account>(
      `insert into printshop.accounts (id, email, display_name) values ($1, $2, $3)
       on conflict (id) do update set email = excluded.email returning *`, [user.id, user.email.toLowerCase(), name || 'Customer']);
    return account.disabled ? null : account;
  }
  const token = (await cookies()).get(cookieName)?.value;
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  const [account] = await (await database()).query<Account>(`
    select a.* from printshop.accounts a join printshop.demo_sessions s on s.account_id = a.id
    where s.token_hash = $1 and s.expires_at > now() and not a.disabled`, [hashToken(token)]);
  return account ?? null;
}

export async function requireAccount(staff = false) {
  const account = await accountForRequest();
  if (!account) throw new PrintError('Sign in to continue.', 401);
  if (staff && account.role !== 'staff') throw new PrintError('Staff access is required.', 403);
  return account;
}

export async function logout() {
  if (hosted()) {
    const { error } = await (await supabase()).auth.signOut({ scope: 'local' });
    if (error) throw new PrintError('Sign-out failed. Try again.', 503);
    return;
  }
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  if (token) await (await database()).query('delete from printshop.demo_sessions where token_hash = $1', [hashToken(token)]);
  jar.delete(cookieName);
}
