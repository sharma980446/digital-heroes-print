'use client';

import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Account } from '@/server/auth';
import type { Quote } from '@/domain/catalogue';
import { money } from '@/domain/catalogue';

const url = (route: string) => `/api/print/${route}`;
export const endpoint = url;

export function message(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function api<T>(route: string, data?: object) {
  const response = await fetch(url(route), data === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new ApiError(payload?.error ?? 'The store is temporarily unavailable. Try again.', response.status);
  return payload as T;
}

export function useLoad<T>(route: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!route);
  const reload = useCallback(async () => {
    if (!route) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setData(await api<T>(route));
      setError('');
    } catch (problem) { setError(message(problem)); }
    finally { setLoading(false); }
  }, [route]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}

const Session = createContext<{ account: Account | null; demo: boolean; loading: boolean; error: string; refresh: () => Promise<void> } | null>(null);
export function useSession() { return useContext(Session)!; }

export function Interactivity({ children }: { children: ReactNode }) {
  const session = useLoad<{ account: Account | null; demo: boolean }>('auth/session');
  const account = session.data?.account ?? null;
  return <Session.Provider value={{ account, demo: session.data?.demo ?? false, loading: session.loading, error: session.error, refresh: session.reload }}>
    <a href="#main" className="skip-link">Skip to content</a>
    <header className="site-header">
      <div className="wrap header-inner">
        <Link href="/" className="brand" aria-label="Digital Heroes Print home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Digital Heroes<small>PRINT STUDIO</small></span>
        </Link>
        <nav aria-label="Main navigation">
          <Link href="/#products">Products</Link>
          {account?.role !== 'staff' ? <Link href="/#gallery">Gallery</Link> : null}
          {account?.role === 'staff' ? <Link href="/staff">Production</Link> : null}
          <Link className="nav-account" href="/account">{account ? 'Account' : 'Sign in'}</Link>
        </nav>
      </div>
    </header>
    <main id="main">{children}</main>
    <footer className="site-footer"><div className="wrap footer-inner"><b>Digital Heroes Print</b>
      <div><Link href="/#products">Products</Link><Link href="/account">Your account</Link></div>
    </div></footer>
  </Session.Provider>;
}

export function Feedback({ error, info }: { error?: string; info?: string }) {
  if (!error && !info) return null;
  return <p className={error ? 'notice error' : 'notice'} role={error ? 'alert' : 'status'}>{error || info}</p>;
}

export function Loading({ children = 'Loading…' }: { children?: ReactNode }) {
  return <p role="status" className="muted loading">{children}</p>;
}

export function dateLabel(value: string | Date) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value));
}

const labels: Record<string, string> = {
  'order': 'Order received', 'artwork': 'Artwork', 'proof': 'Proof', 'production': 'In production', 'completed': 'Completed',
  'draft': 'Draft', 'review': 'Awaiting approval', 'changes': 'Changes requested', 'approved': 'Approved',
  'queued': 'Queued', 'running': 'Rendering', 'ready': 'Ready', 'failed': 'Failed',
  'order_created': 'Order placed', 'quote_revised': 'Quote updated', 'draft_saved': 'Draft saved',
  'proof_published': 'Proof published', 'proof_approved': 'Proof approved', 'changes_requested': 'Changes requested',
  'payment_confirmed': 'Payment confirmed', 'payment_review': 'Payment needs review', 'payment_review_resolved': 'Payment review resolved',
  'generation_ready': 'Files ready', 'generation_failed': 'File generation failed', 'generation_retried': 'File generation retried',
  'production_started': 'Production started', 'order_completed': 'Order completed', 'approval_reused': 'Approval carried over',
  'demo': 'Logged in local demo', 'sent': 'Accepted by email provider', 'pending': 'Pending', 'sending': 'Sending',
};
export const stateName = (name: string) => labels[name] ?? name;

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warning' }) {
  return <span className={`status-tag ${tone}`}>{children}</span>;
}

export function SignInPanel({ next, staff }: { next: string; staff?: boolean }) {
  return <div className="wrap page-head">
    <h1>{staff ? 'Staff sign-in required' : 'Sign in to continue'}</h1>
    <p>{staff ? 'Use a staff account to access the production console.' : 'Open your account to see your orders and proofs.'}</p>
    <Link className="button" href={`/account?next=${encodeURIComponent(next)}`}>Sign in</Link>
  </div>;
}

export function QuoteSummary({ quote, children }: { quote: Quote | null; children?: ReactNode }) {
  return <aside className="quote-summary" aria-label="Price summary">
    <p className="eyebrow">YOUR QUOTE</p>
    <div className="quote-value" aria-live="polite">
      {quote ? money(quote.total, quote.currency) : '—'} <small>{quote ? 'incl. tax' : ''}</small>
    </div>
    {quote ? <dl className="money-lines">
      <div><dt>Before discount</dt><dd>{money(quote.beforeDiscount, quote.currency)}</dd></div>
      {quote.discountBps > 0 ? <div><dt>Volume discount ({quote.discountBps / 100}%)</dt><dd>−{money(quote.discount, quote.currency)}</dd></div> : null}
      <div><dt>Tax ({quote.taxBps / 100}%)</dt><dd>{money(quote.tax, quote.currency)}</dd></div>
      <div><dt>Average per unit</dt><dd>{money(quote.unitAverage, quote.currency)}</dd></div>
    </dl> : <p className="muted">Enter valid dimensions and quantity for a total.</p>}
    {children}
  </aside>;
}
