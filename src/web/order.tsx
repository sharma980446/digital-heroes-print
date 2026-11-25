'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ORDER_CURRENCY, money, taxName } from '@/domain/catalogue';
import type { orderDetails } from '@/server/orders';
import { api, ApiError, dateLabel, endpoint, Feedback, Loading, message, SignInPanel, stateName, Tag, useLoad, useSession } from './ui';

const OrderEditor = dynamic(() => import('./order-editor').then((module) => module.OrderEditor), {
  loading: () => <Loading>Loading artwork editor…</Loading>,
});

type Detail = Awaited<ReturnType<typeof orderDetails>>;
type Action = (name: string, data: object) => Promise<void>;

function StatusPanel({ detail, staff, action, busy }: { detail: Detail; staff: boolean; action: Action; busy: boolean }) {
  const { order, unlocked, job } = detail;
  const [note, setNote] = useState('');
  return <aside className="order-sidebar">
    <section className="panel order-status">
      <div className="panel-head"><h2>Order status</h2></div>
      <dl className="status-lines">
        <div><dt>Stage</dt><dd><Tag tone={order.stage === 'completed' ? 'good' : 'neutral'}>{stateName(order.stage)}</Tag></dd></div>
        <div><dt>Proof</dt><dd>{stateName(order.proof_state)}</dd></div>
        <div><dt>Payment</dt><dd><Tag tone={order.payment_review ? 'warning' : order.paid_at ? 'good' : 'neutral'}>
          {order.payment_review ? 'Needs review' : order.paid_at ? 'Paid' : 'Unpaid'}</Tag></dd></div>
        <div><dt>File generation</dt><dd>{job ? stateName(job.status) : 'Waiting'}</dd></div>
      </dl>
      {job?.status === 'running' || job?.status === 'queued' ? <div className="progress-line">
        <progress value={job.processed_rows} max={job.expected_rows} aria-label="Rows rendered" />
        <p>{job.processed_rows} of {job.expected_rows} {job.expected_rows === 1 ? 'artwork rendered' : 'rows rendered'}</p>
      </div> : null}
      {job?.status === 'failed' ? <Feedback error={staff ? job.error ?? 'File generation failed.' : 'The print team needs to retry file generation.'} /> : null}
      {staff ? <>
        {order.payment_review ? <form className="stack" onSubmit={(e) => { e.preventDefault(); void action('stage', { action: 'resolve', note }); }}>
          <label className="field">Resolution note<textarea required value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <button className="button secondary" disabled={busy || !note.trim()}>Resolve payment review</button>
        </form> : null}
        {job?.status === 'failed' && !order.payment_review ? <button className="button secondary full" disabled={busy}
          onClick={() => void action('stage', { action: 'retry' })}>Retry file generation</button> : null}
        {unlocked && order.stage === 'proof' ? <button className="button full" disabled={busy}
          onClick={() => void action('stage', { action: 'start' })}>Start production</button> : null}
        {unlocked && order.stage === 'production' ? <button className="button full" disabled={busy}
          onClick={() => void action('stage', { action: 'complete' })}>Mark completed</button> : null}
      </> : null}
    </section>
    <section className="panel order-spec">
      <div className="panel-head"><h2>Print specification</h2></div>
      <dl className="money-lines">
        <div><dt>Trim size</dt><dd>{order.config.width} × {order.config.height} mm</dd></div>
        <div><dt>Material</dt><dd>{order.price.material}</dd></div>
        <div><dt>Quantity</dt><dd>{order.config.quantity}</dd></div>
        <div><dt>Net subtotal</dt><dd>{money(order.price.subtotal, order.price.currency)}</dd></div>
        <div><dt>{taxName(order.price.currency)}</dt><dd>{money(order.price.tax, order.price.currency)}</dd></div>
        <div className="total-line"><dt>Total</dt><dd>{money(order.price.total, order.price.currency)}</dd></div>
      </dl>
      {order.paid_at ? <a className="button secondary full" href={endpoint(`orders/${order.id}/receipt`)}>Download receipt</a> : null}
    </section>
  </aside>;
}

function ProofPanel({ detail, staff, onEdit, editable, action, busy, pay }: {
  detail: Detail; staff: boolean; editable: boolean; onEdit: () => void; action: Action; busy: boolean; pay: () => void;
}) {
  const { order, proofs } = detail;
  const current = proofs.find((proof) => proof.id === order.current_proof_id);
  const [selected, setSelected] = useState(current?.id ?? proofs[0]?.id ?? '');
  const [row, setRow] = useState(0);
  const [changes, setChanges] = useState(false);
  const [comment, setComment] = useState('');
  const [loaded, setLoaded] = useState('');
  const [unavailable, setUnavailable] = useState('');
  const proof = proofs.find((item) => item.id === selected) ?? current;
  if (!proof) return <section className="panel empty"><h2>No proof yet</h2><p>The print team needs artwork to publish a proof.</p></section>;
  const image = endpoint(`orders/${order.id}/proof/${proof.id}?row=${row}`);
  const isCurrent = current?.id === proof.id && order.proof_state !== 'draft';
  const needsInrQuote = !staff && order.price.currency !== ORDER_CURRENCY;
  return <section className="panel proof-panel">
    <div className="panel-head spread"><div>
      <h2>Print proof</h2>
      <p>{dateLabel(proof.created_at)} UTC{isCurrent ? ' · Current version' : ''}</p>
    </div>
    <label className="field compact-field">Version<select aria-label="Version" value={proof.id} onChange={(e) => { setSelected(e.target.value); setRow(0); setChanges(false); }}>
      {proofs.map(({ id, version }) => <option key={id} value={id}>v{version}{id === current?.id ? ' · Latest' : ''}</option>)}</select></label></div>
    {proof.names.length ? <div className="preview-toolbar spread">
      <p>{proof.names.length} runners in this proof</p>
      <label className="field compact-field">Runner<select aria-label="Runner" value={row} onChange={(e) => setRow(Number(e.target.value))}>
        {proof.names.map(({ name, number }, index) => <option key={number} value={index}>{number} · {name}</option>)}
      </select></label>
    </div> : null}
    <div className="proof-canvas" aria-busy={loaded !== image && unavailable !== image}>
      <img key={image} src={image} hidden={loaded !== image}
        onLoad={() => { setLoaded(image); setUnavailable(''); }} onError={() => setUnavailable(image)}
        alt={proof.names[row] ? `Print proof for ${proof.names[row].name}, bib ${proof.names[row].number}` : 'Print artwork proof'} />
      {loaded !== image ? <p role="status">{unavailable === image ? 'The preview is unavailable. Refresh the order to retry.' : 'Loading proof…'}</p> : null}
    </div>
    <div className="proof-meta spread">
      <span>{proof.approved_at ? `Approved by ${proof.approver} · ${dateLabel(proof.approved_at)} UTC` :
        isCurrent && order.proof_state === 'review' ? 'Awaiting customer approval' : stateName(isCurrent ? order.proof_state : 'Previous version')}</span>
      <a href={`${image}&download=1`} className="text-link">Download proof</a>
    </div>
    {proof.carried_from && order.reordered_from ? <p className="muted">Approval carried over from <Link href={`/orders/${order.reordered_from}`} className="text-link">the previous order</Link>.</p> : null}
    {order.payment_review ? <Feedback error="Payment needs staff review. Production stays on hold." /> : null}
    {changes ? <form className="change-form" onSubmit={(e) => {
      e.preventDefault(); void action('changes', { proofId: proof.id, revision: order.revision, comment });
    }}>
      <label className="field">What should change?<textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} required /></label>
      <div className="actions"><button className="button secondary" type="button" onClick={() => setChanges(false)}>Back</button>
        <button className="button" disabled={busy || !comment.trim()}>Send change request</button></div>
    </form> : <div className="actions">
      {editable ? <button className="button secondary" disabled={busy} onClick={onEdit}>
        {needsInrQuote ? 'Review INR quote' : staff ? 'Revise artwork' : 'Edit artwork'}
      </button> : null}
      {!staff && !order.paid_at && !order.payment_review && isCurrent && order.proof_state === 'review' ? <>
        <button className="button secondary" disabled={busy} onClick={() => setChanges(true)}>Request changes</button>
        <button className="button" disabled={busy || loaded !== image} onClick={() => void action('approve', { proofId: proof.id, revision: order.revision })}>Approve v{proof.version}</button>
      </> : null}
      {!staff && !needsInrQuote && !order.paid_at && !order.payment_review && isCurrent && order.proof_state === 'approved' ? <button className="button"
        disabled={busy} onClick={pay}>Continue to test checkout</button> : null}
    </div>}
  </section>;
}

function Files({ detail }: { detail: Detail }) {
  const [row, setRow] = useState(1);
  const rows = [...new Set(detail.files.filter((file) => file.format !== 'zip').map((file) => file.row_number))];
  const output = detail.files.filter((file) => file.row_number === row && file.format !== 'zip');
  const archives = detail.files.filter((file) => file.format === 'zip');
  return <section className="panel">
    <div className="panel-head spread"><div><h2>Production files</h2>
      <p>{detail.unlocked ? `${rows.length} ${rows.length === 1 ? 'artwork' : 'rows'} · ${detail.order.config.quantity} units` : 'Ready after approval, payment and file generation.'}</p></div>
      {rows.length > 1 ? <label className="field compact-field">Output row<select aria-label="Output row" value={row} onChange={(e) => setRow(Number(e.target.value))}>
        {rows.map((index) => <option key={index} value={index}>Row {index}</option>)}</select></label> : null}
    </div>
    {detail.unlocked ? <div className="actions">{output.map((file) => <a key={file.filename} className="button secondary"
      href={endpoint(`orders/${detail.order.id}/files/${file.row_number}/${file.format}`)}>
      Download {file.format.toUpperCase()}
    </a>)}{archives.map((file, index) => <a key={file.filename} className="button"
      href={endpoint(`orders/${detail.order.id}/files/${file.row_number}/zip`)}>
      {archives.length === 1 ? 'Download batch ZIP' : `Download batch part ${index + 1} of ${archives.length}`}
    </a>)}</div> : null}
  </section>;
}

function History({ detail, staff }: { detail: Detail; staff: boolean }) {
  return <section className="panel history">
    <div className="panel-head"><h2>Order history</h2></div>
    <ol>
      {detail.timeline.map((item) => <li key={item.id}>
        <div><strong>{stateName(item.event_type)}</strong>{item.actor ? <span> · {item.actor}</span> : null}</div>
        <time>{dateLabel(item.created_at)} UTC</time>
        {typeof item.detail.comment === 'string' ? <p>{item.detail.comment}</p> : null}
        {staff && typeof item.detail.reason === 'string' ? <p>{item.detail.reason}</p> : null}
      </li>)}
    </ol>
    {staff && detail.payments.length ? <details><summary>Payment records</summary><ul>
      {detail.payments.map((payment) => <li key={payment.reference}><strong>{money(payment.amount, payment.currency)}</strong> · {payment.status} · {payment.reference}</li>)}
    </ul></details> : null}
    {staff && detail.notifications.length ? <details><summary>Notification log</summary><ul>
      {detail.notifications.map((notification, index) => <li key={index}>{stateName(notification.event_type)} · {stateName(notification.status)}
        {notification.sent_at ? ` · ${dateLabel(notification.sent_at)} UTC` : ''}</li>)}
    </ul></details> : null}
  </section>;
}

export function OrderScreen({ id }: { id: string }) {
  const { account, loading } = useSession();
  const { data, error, reload } = useLoad<Detail>(account ? `orders/${id}` : null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [testAttempt, setTestAttempt] = useState('');
  const [paymentReturn, setPaymentReturn] = useState('');
  const reorderKey = useRef<string | null>(null);
  const router = useRouter();
  const jobStatus = data?.job?.status;
  const checkPayment = paymentReturn === 'checking' && !data?.order.paid_at;
  useEffect(() => { setPaymentReturn(new URLSearchParams(window.location.search).get('payment') ?? ''); }, []);
  useEffect(() => {
    if (!checkPayment && jobStatus !== 'queued' && jobStatus !== 'running') return;
    const timer = setInterval(() => { void reload(); }, 2200);
    return () => clearInterval(timer);
  }, [jobStatus, reload, checkPayment]);

  if (loading && !account) return <div className="wrap screen"><Loading /></div>;
  if (!account) return <SignInPanel next={`/orders/${id}`} />;
  if (!data || data.order.id !== id) return <div className="wrap screen">
    {error ? <><Feedback error={error} /><Link className="button secondary" href="/account">Back to account</Link></> : <Loading>Loading order…</Loading>}
  </div>;
  const { order } = data;
  const staff = account.role === 'staff';
  const editable = !order.paid_at && !order.payment_review;
  const showEditor = editable && (editing || (!staff && (!order.current_proof_id || order.proof_state === 'draft')));
  const latestComment = data.timeline.find((entry) => entry.event_type === 'changes_requested')?.detail.comment;

  const action: Action = async (name, input) => {
    setActionError(''); setBusy(true);
    try {
      await api(`orders/${id}/${name}`, input);
      if (name === 'demo-payment') setTestAttempt('');
      await reload();
    } catch (value) {
      setActionError(message(value));
      if (value instanceof ApiError && value.status === 409) await reload();
    }
    finally { setBusy(false); }
  };

  async function pay() {
    setActionError(''); setBusy(true);
    try {
      const checkout = await api<{ demo: true; attemptId: string } | { demo: false; url: string }>(`orders/${id}/checkout`, {});
      if (checkout.demo) setTestAttempt(checkout.attemptId);
      else window.location.assign(checkout.url);
    } catch (value) { setActionError(message(value)); }
    finally { setBusy(false); }
  }

  async function repeat() {
    setActionError(''); setBusy(true);
    try {
      reorderKey.current ??= crypto.randomUUID();
      const next = await api<{ id: string }>(`orders/${id}/reorder`, { key: reorderKey.current });
      router.push(`/orders/${next.id}`);
    } catch (value) { setActionError(message(value)); }
    finally { setBusy(false); }
  }

  return <div className="wrap screen">
    <div className="page-head compact spread"><div>
      <Link className="back" href={staff ? '/staff' : '/account'}>{staff ? 'Production console' : 'Order history'}</Link>
      <span className="eyebrow order-number">DH{order.number}</span><h1>{order.product_snapshot.title}</h1>
      <p>{order.config.quantity} units · {order.price.material} · {money(order.price.total, order.price.currency)} incl. tax</p>
    </div>{!staff && order.paid_at && !order.payment_review ? <button className="button secondary" disabled={busy} onClick={() => void repeat()}>Reorder design</button> : null}</div>
    <Feedback error={actionError || error} info={checkPayment ? 'Waiting for the payment provider to confirm your payment.' :
      paymentReturn === 'cancelled' && !order.paid_at ? 'Checkout cancelled. You can return to the same approved proof.' : undefined} />
    <div className="two-col order-layout">
      <div className="stack order-main">
        {order.proof_state === 'changes' && latestComment ? <Feedback info={`Changes requested. ${latestComment}`} /> : null}
        {testAttempt ? <section className="panel test-pay">
          <div className="panel-head"><h2>Test checkout</h2><p>Simulated payment of {money(order.price.total, order.price.currency)}.</p></div>
          <div className="actions"><button className="button secondary" disabled={busy} onClick={() => setTestAttempt('')}>Cancel checkout</button>
            <button className="button" disabled={busy} onClick={() => void action('demo-payment', { attemptId: testAttempt })}>Confirm test payment</button></div>
        </section> : null}
        {showEditor ? <>
          {editing && order.current_proof_id ? <div><button className="button secondary" onClick={() => setEditing(false)}>View previous proof</button></div> : null}
          <OrderEditor key={`${id}:${order.revision}`} order={order} staff={staff} onSaved={() => { setEditing(false); void reload(); }} />
        </> : <ProofPanel key={`${id}:${order.revision}`} detail={data} staff={staff} editable={editable}
          onEdit={() => { setTestAttempt(''); setEditing(true); }} action={action} busy={busy} pay={() => void pay()} />}
        {staff ? <Files detail={data} /> : null}
      </div>
      <StatusPanel detail={data} staff={staff} action={action} busy={busy} />
      <History detail={data} staff={staff} />
    </div>
  </div>;
}
