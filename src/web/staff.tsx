'use client';

import { useState, type FormEvent } from 'react';
import { money, type Product } from '@/domain/catalogue';
import type { Account } from '@/server/auth';
import type { listOrders } from '@/server/orders';
import type { reports } from '@/server/operations';
import { OrderRows } from './account';
import { api, endpoint, Feedback, Loading, message, SignInPanel, stateName, Tag, useLoad, useSession } from './ui';
import { useCatalogue } from './store';

const stages = ['order', 'artwork', 'proof', 'production', 'completed'];
type Filter = { stage: string; family: string; search: string; from: string; to: string };
const defaults: Filter = { stage: '', family: '', search: '', from: '', to: '' };
const parameters = (filters: Partial<Filter>) => new URLSearchParams(
  Object.entries(filters).filter(([, value]) => !!value),
).toString();

function Queue({ archive }: { archive: boolean }) {
  const [form, setForm] = useState<Filter>({ ...defaults, stage: archive ? 'completed' : '' });
  const [active, setActive] = useState(form);
  const { catalogue } = useCatalogue();
  const results = useLoad<Awaited<ReturnType<typeof listOrders>>>(`orders?${parameters(active)}`);
  return <>
    <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); setActive({ ...form }); }}>
      <label className="field">Customer or job<input type="search" placeholder="Name, email or DH number" value={form.search}
        onChange={(e) => setForm({ ...form, search: e.target.value })} /></label>
      {!archive ? <label className="field">Stage<select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
        <option value="">All stages</option>{stages.map((stage) => <option value={stage} key={stage}>{stateName(stage)}</option>)}
      </select></label> : null}
      <label className="field">Product family<select value={form.family} onChange={(e) => setForm({ ...form, family: e.target.value })}>
        <option value="">All products</option>{catalogue.map(({ id, title }) => <option value={id} key={id}>{title}</option>)}
      </select></label>
      <label className="field">From (UTC)<input type="date" value={form.from} max={form.to || undefined} onChange={(e) => setForm({ ...form, from: e.target.value })} /></label>
      <label className="field">To (UTC)<input type="date" value={form.to} min={form.from || undefined} onChange={(e) => setForm({ ...form, to: e.target.value })} /></label>
      <button className="button">Apply filters</button>
    </form>
    <Feedback error={results.error} />
    {results.loading ? <Loading>Loading jobs…</Loading> : <OrderRows orders={results.data ?? []} staff />}
  </>;
}

function Reports() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const result = useLoad<Awaited<ReturnType<typeof reports>>>(`staff/reports?${query}`);
  const { catalogue } = useCatalogue();
  const gross = result.data?.reduce((sum, row) => sum + row.revenue, 0) ?? 0;
  const units = result.data?.reduce((sum, row) => sum + row.units, 0) ?? 0;
  return <>
    <form className="filter-bar report-filter" onSubmit={(event) => { event.preventDefault(); setQuery(parameters({ from, to })); }}>
      <label className="field">From (UTC)<input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="field">To (UTC)<input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
      <button className="button">Update report</button>
      <a className="button secondary" href={endpoint('staff/export')}>Export accounting CSV</a>
    </form>
    <Feedback error={result.error} />
    {result.loading ? <Loading /> : null}
    {result.data ? <>
      <div className="report-metrics"><div><span>Orders created</span><strong>{result.data.reduce((sum, item) => sum + item.orders, 0)}</strong></div>
        <div><span>Gross collected (GBP, test)</span><strong>{money(gross)}</strong></div><div><span>Completed units</span><strong>{units}</strong></div></div>
      <div className="table-scroll"><table><thead><tr><th>Product family</th><th>Orders</th><th>Gross</th><th>Completed jobs</th><th>Units</th></tr></thead>
        <tbody>{result.data.map((row) => <tr key={row.family}><th>{catalogue.find(({ id }) => id === row.family)?.title ?? row.family}</th>
          <td>{row.orders}</td><td>{money(row.revenue)}</td><td>{row.completed}</td><td>{row.units}</td></tr>)}</tbody></table></div>
    </> : null}
  </>;
}

function ProductEditor({ initial, refresh }: { initial: Product; refresh: () => Promise<void> }) {
  const [item, setItem] = useState(initial);
  const [status, setStatus] = useState<{ error?: string; info?: string }>({});
  const [busy, setBusy] = useState(false);
  const fields = [
    ['basePence', 'Base net (pence)'], ['vatBps', 'VAT (basis points)'], ['referenceWidth', 'Reference width (mm)'],
    ['referenceHeight', 'Reference height (mm)'], ['ppi', 'Resolution (ppi)'], ['bleed', 'Bleed (mm)'], ['safeInset', 'Safe inset (mm)'],
  ] as const;
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { await api('staff/catalogue', item); await refresh(); }
    catch (error) { setStatus({ error: message(error) }); }
    finally { setBusy(false); }
  }
  return <form className="panel" onSubmit={save}>
    <div className="panel-head spread"><h2>{initial.title}</h2><Tag>Revision {initial.revision}</Tag></div>
    <div className="form-grid">
      <label className="field">Product title<input required value={item.title} onChange={(e) => setItem({ ...item, title: e.target.value })} /></label>
      <label className="field">Description<input required value={item.description} onChange={(e) => setItem({ ...item, description: e.target.value })} /></label>
      {fields.map(([key, label]) => <label className="field" key={key}>{label}
        <input required type="number" step={key === 'safeInset' ? '.1' : '1'} value={item[key]}
          onChange={(e) => setItem({ ...item, [key]: Number(e.target.value) })} /></label>)}
      <label className="field">Default artwork text<input required value={item.sample} onChange={(e) => setItem({ ...item, sample: e.target.value })} /></label>
      <label className="field">Default background<input type="color" value={item.background} onChange={(e) => setItem({ ...item, background: e.target.value })} /></label>
      <label className="field">Default ink<input type="color" value={item.ink} onChange={(e) => setItem({ ...item, ink: e.target.value })} /></label>
    </div>
    <label className="checkbox"><input type="checkbox" checked={item.active} onChange={(e) => setItem({ ...item, active: e.target.checked })} />Available to order</label>
    <h3>Materials</h3>
    {item.materials.map((material, index) => <div className="material-row" key={index}>
      <label className="field">Code<input required pattern="[a-z][a-z0-9-]*" value={material.id}
        onChange={(e) => setItem({ ...item, materials: item.materials.map((m, i) => index === i ? { ...m, id: e.target.value } : m) })} /></label>
      <label className="field">Name<input required value={material.title}
        onChange={(e) => setItem({ ...item, materials: item.materials.map((m, i) => index === i ? { ...m, title: e.target.value } : m) })} /></label>
      <label className="field">Multiplier (basis points)<input required type="number" value={material.multiplierBps}
        onChange={(e) => setItem({ ...item, materials: item.materials.map((m, i) => index === i ? { ...m, multiplierBps: Number(e.target.value) } : m) })} /></label>
      <button className="button secondary" type="button" disabled={item.materials.length === 1}
        onClick={() => setItem({ ...item, materials: item.materials.filter((_, i) => i !== index) })}>Remove</button>
    </div>)}
    <Feedback {...status} />
    <div className="actions">
      <button className="button secondary" type="button" onClick={() => setItem({ ...item, materials: [...item.materials, { id: '', title: '', multiplierBps: 10000 }] })}
        disabled={item.materials.length === 12}>Add material</button>
      <button className="button" disabled={busy}>Save catalogue settings</button>
    </div>
  </form>;
}

function CatalogueSettings() {
  const { data, error, loading, reload } = useLoad<Product[]>('staff/catalogue');
  const [selected, setSelected] = useState('');
  const current = data?.find(({ id }) => id === selected) ?? data?.[0];
  return <>
    <Feedback error={error} />
    {loading && !data ? <Loading /> : null}
    {current ? <><label className="field select-product">Product<select value={current.id} onChange={(e) => setSelected(e.target.value)}>
      {data?.map(({ id, title }) => <option value={id} key={id}>{title}</option>)}
    </select></label>
    <ProductEditor key={`${current.id}-${current.revision}`} initial={current} refresh={reload} /></> : null}
  </>;
}

function CustomerManagement() {
  const { data, error, loading, reload } = useLoad<Account[]>('staff/accounts');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState('');
  async function change(account: Account) {
    setBusy(account.id);
    try { await api('staff/accounts', { id: account.id, disabled: !account.disabled }); await reload(); setProblem(''); }
    catch (error) { setProblem(message(error)); }
    finally { setBusy(''); }
  }
  return <>
    <Feedback error={error || problem} />
    {loading && !data ? <Loading /> : null}
    {data?.map((user) => <div className="staff-user spread" key={user.id}>
      <div><strong>{user.display_name}</strong><small>{user.email}</small></div>
      <Tag tone={user.disabled ? 'warning' : 'neutral'}>{user.role === 'staff' ? 'Staff' : user.disabled ? 'Disabled' : 'Customer'}</Tag>
      {user.role === 'customer' ? <button className="button secondary" disabled={!!busy} onClick={() => void change(user)}>{user.disabled ? 'Re-enable' : 'Disable'}</button> : null}
    </div>)}
  </>;
}

export function StaffScreen() {
  const { account, loading } = useSession();
  const [view, setView] = useState('Queue');
  if (loading && !account) return <div className="wrap screen"><Loading /></div>;
  if (account?.role !== 'staff') return <SignInPanel next="/staff" staff />;
  return <div className="wrap screen">
    <div className="page-head compact"><h1>Production console</h1><p>Track jobs from order through completion.</p></div>
    <nav className="tabs staff-tabs" aria-label="Production views">
      {['Queue', 'Archive', 'Reports', 'Catalogue', 'Users'].map((item) =>
        <button key={item} aria-pressed={view === item} onClick={() => setView(item)}>{item}</button>)}
    </nav>
    {view === 'Queue' || view === 'Archive' ? <Queue key={view} archive={view === 'Archive'} /> : null}
    {view === 'Reports' ? <Reports /> : null}
    {view === 'Catalogue' ? <CatalogueSettings /> : null}
    {view === 'Users' ? <CustomerManagement /> : null}
  </div>;
}
