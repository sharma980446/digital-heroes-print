'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { money } from '@/domain/catalogue';
import { accountReturn } from '@/domain/navigation';
import type { listOrders } from '@/server/orders';
import { api, dateLabel, endpoint, Feedback, Loading, message, stateName, Tag, useLoad, useSession } from './ui';

type Orders = Awaited<ReturnType<typeof listOrders>>;

export function OrderRows({ orders, staff = false }: { orders: Orders; staff?: boolean }) {
  if (!orders.length) return <div className="empty">
    <h3>{staff ? 'No jobs match these filters' : 'No orders here yet'}</h3>
    <p>{staff ? 'Adjust the date range, stage or search.' : 'Configure a print product to create your first order.'}</p>
    {!staff ? <Link className="button secondary" href="/#products">Browse products</Link> : null}
  </div>;
  return <div className="order-list">
    {orders.map((order) => <Link key={order.id} href={`/orders/${order.id}`} className="order-row">
      <div><span className="mono summary-ref">DH{order.number}</span><strong>{order.title}</strong>
        <small>{staff ? `${order.customer} · ` : ''}{order.quantity} units · {dateLabel(order.created_at)}</small></div>
      <div className="row-status"><Tag tone={order.stage === 'completed' ? 'good' : 'neutral'}>{stateName(order.stage)}</Tag>
        {staff || !order.paid ? <small>{order.payment_review ? 'Payment review' : order.paid ? 'Paid' : 'Unpaid'}
          {staff ? ` · ${order.files ? stateName(order.files) : 'Files locked'}` : ''}</small> : null}</div>
      <b>{money(order.amount)}</b>
    </Link>)}
  </div>;
}

function AuthForm() {
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const { refresh, demo } = useSession();
  const router = useRouter();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(''); setInfo('');
    const data = new FormData(event.currentTarget);
    const next = accountReturn(new URLSearchParams(location.search).get('next'));
    try {
      const result = await api<{ confirmationRequired: boolean }>(create ? 'auth/signup' : 'auth/login', {
        email: data.get('email'), password: data.get('password'), next, ...(create ? { name: data.get('name') } : {}),
      });
      if (result.confirmationRequired) {
        setInfo('Check your inbox and confirm your account, then sign in.');
      } else {
        await refresh();
        if (next !== '/account') router.push(next);
      }
    } catch (problem) { setError(message(problem)); }
    finally { setBusy(false); }
  }
  return <section className="wrap auth-layout">
    <div className="auth-intro">
      <p className="eyebrow">PRINT STUDIO ACCOUNT</p>
      <h1>{create ? 'Set up your account.' : 'Your jobs, in one place.'}</h1>
      <p>Review artwork, track production and reorder past work.</p>
    </div>
    <form className="panel auth-card" onSubmit={submit}>
      <div className="tabs" aria-label="Account action">
        <button type="button" aria-pressed={!create} onClick={() => { setCreate(false); setError(''); setInfo(''); }}>Sign in</button>
        <button type="button" aria-pressed={create} onClick={() => { setCreate(true); setError(''); setInfo(''); }}>Create account</button>
      </div>
      {create ? <label className="field">Name<input name="name" autoComplete="name" required minLength={2} maxLength={80} /></label> : null}
      <label className="field">Email<input name="email" type="email" autoComplete="email" required /></label>
      <label className="field">Password<input name="password" type="password" autoComplete={create ? 'new-password' : 'current-password'}
        required minLength={8} maxLength={128} />{create ? <small>At least 8 characters</small> : null}</label>
      <Feedback error={error} info={info} />
      <button className="button full" disabled={busy}>{busy ? 'Continuing…' : create ? 'Create account' : 'Sign in'}</button>
      {demo ? <p className="muted">Local demo. Use a test email and password.</p> : null}
    </form>
  </section>;
}

function CustomerHome({ account }: { account: NonNullable<ReturnType<typeof useSession>['account']> }) {
  const { refresh } = useSession();
  const { data, error, loading, reload } = useLoad<Orders>('orders');
  const [tab, setTab] = useState<'orders' | 'proofs' | 'designs'>('orders');
  const [name, setName] = useState(account.display_name);
  const [status, setStatus] = useState<{ error?: string; info?: string }>({});
  const [busy, setBusy] = useState(false);

  async function profile(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try { await api('auth/profile', { name }); await refresh(); setStatus({ info: 'Profile saved.' }); }
    catch (error) { setStatus({ error: message(error) }); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    try { await api('auth/logout', {}); await refresh(); }
    catch (error) { setStatus({ error: message(error) }); setBusy(false); }
  }
  return <div className="wrap screen">
    <div className="page-head compact spread"><div><h1>{account.role === 'staff' ? 'Staff account' : 'Your account'}</h1><p>{account.email}</p></div>
      <button className="button secondary" onClick={signOut} disabled={busy}>Sign out</button></div>
    <div className="account-layout">
      <section>
        {account.role === 'staff' ? <Link href="/staff" className="button">Open production console</Link> : <>
          <div className="tabs" aria-label="Your account views">
            <button aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}>Order history</button>
            <button aria-pressed={tab === 'proofs'} onClick={() => setTab('proofs')}>Active proofs</button>
            <button aria-pressed={tab === 'designs'} onClick={() => setTab('designs')}>Saved designs</button>
          </div>
          <Feedback error={error} />
          {loading && !data ? <Loading /> : null}
          {error ? <button className="button secondary" onClick={() => void reload()}>Retry</button> : null}
          {data && tab !== 'designs' ? <OrderRows orders={tab === 'proofs' ? data.filter(({ proof_state, paid }) =>
            !paid && (proof_state === 'review' || proof_state === 'changes' || proof_state === 'approved')) : data} /> : null}
          {data && tab === 'designs' ? <div className="saved-grid">
            {data.filter(({ proof_id, paid }) => proof_id && paid).map((order) => <Link className="saved-design" key={order.id} href={`/orders/${order.id}`}>
              {/* Proof URLs require the customer's session cookie. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={endpoint(`orders/${order.id}/proof/${order.proof_id}`)} alt={order.title} loading="lazy" />
              <div><strong>DH{order.number} · {order.title}</strong>
              <small>{order.configuration.width} × {order.configuration.height} mm · {order.quantity} units</small></div>
            </Link>)}
            {!data.some(({ proof_id, paid }) => proof_id && paid) ? <div className="empty"><h3>No saved designs</h3><p>Paid orders with approved artwork appear here.</p></div> : null}
          </div> : null}
        </>}
      </section>
      <form className="panel" onSubmit={profile}>
        <div className="panel-head spread"><h2>Profile</h2><Tag tone="good">Active</Tag></div>
        <label className="field">Display name<input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} /></label>
        <Feedback {...status} />
        <button className="button secondary" disabled={busy || name.trim() === account.display_name}>Save profile</button>
      </form>
    </div>
  </div>;
}

export function AccountScreen() {
  const { account, loading, error } = useSession();
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => { setConfirmation(new URLSearchParams(window.location.search).get('confirmation') ?? ''); }, []);
  if (loading && !account) return <div className="wrap screen"><Loading /></div>;
  return <>
    {confirmation === 'failed' || error ? <div className="wrap"><Feedback error={error || 'This confirmation link is invalid or expired.'} /></div> : null}
    {account ? <CustomerHome key={account.id} account={account} /> : <AuthForm />}
  </>;
}
