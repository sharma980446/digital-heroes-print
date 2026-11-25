'use client';

import { useEffect, useMemo, useState } from 'react';
import { ORDER_CURRENCY, money, type Configuration, type Product } from '@/domain/catalogue';
import { defaultDesign, printSize, type Design, type DrawElement } from '@/domain/design';
import type { Order } from '@/server/orders';
import { ConfigFields, quoteView, useCatalogue } from './store';
import { api, endpoint, Feedback, message } from './ui';

const numericField = { step: '.1', type: 'number' } as const;
type EditorDesign = Extract<Design, { mode: 'editor' }>;

async function upload(orderId: string, file: File, kind: 'logo' | 'artwork') {
  const format = file.name.split('.').at(-1)?.toLowerCase();
  if (!format || !['png', 'svg', 'pdf', 'ai'].includes(format)) throw new Error('Use a PNG, SVG, PDF or PDF-compatible AI file.');
  const ticket = await api<{ id: string; url: string | null }>(`orders/${orderId}/upload`, { kind, format, size: file.size });
  const response = ticket.url ?
    await fetch(ticket.url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } }) :
    null;
  if (response && !response.ok) throw new Error('Could not upload the file. Try again.');
  const final = await fetch(endpoint(`orders/${orderId}/upload/${ticket.id}`), { method: 'POST', body: ticket.url ? undefined : file });
  const answer = await final.json();
  if (!final.ok) throw new Error(answer.error ?? 'The file could not be read.');
  return answer as { id: string; width: number; height: number };
}

function ElementFields({ element, set, remove, order, index }: { element: DrawElement; set: (value: DrawElement) => void; remove: () => void; order: Order; index: number }) {
  const edit = (key: 'x' | 'y' | 'rotation', value: number) => set({ ...element, [key]: value });
  return <fieldset className="element-control">
    <legend>{element.kind === 'text' ? 'Text' : 'Logo'} {index + 1}</legend>
    <div className="form-grid">
      {element.kind === 'text' ? <>
        <label className="field">Text<input value={element.text} maxLength={120} onChange={(e) => set({ ...element, text: e.target.value })} /></label>
        <label className="field">Font<select value={element.font} onChange={(e) => set({ ...element, font: e.target.value as 'mono' | 'manrope' })}>
          <option value="mono">IBM Plex Mono</option><option value="manrope">Manrope</option></select></label>
        <label className="field">Size (mm)<input {...numericField} min={1} max={150} value={element.size} onChange={(e) => set({ ...element, size: Number(e.target.value) })} /></label>
        <label className="field">Ink<input type="color" value={element.color} onChange={(e) => set({ ...element, color: e.target.value })} /></label>
      </> : <label className="field">Logo width (mm)<input {...numericField} min={1} max={order.config.width} value={element.width}
        onChange={(e) => set({ ...element, width: Number(e.target.value) })} /></label>}
      <label className="field">Horizontal centre (mm)<input {...numericField} min={0} max={order.config.width} value={element.x} onChange={(e) => edit('x', Number(e.target.value))} /></label>
      <label className="field">Vertical centre (mm)<input {...numericField} min={0} max={order.config.height} value={element.y} onChange={(e) => edit('y', Number(e.target.value))} /></label>
      <label className="field">Rotation (°)<input type="number" step={1} min={-180} max={180} value={element.rotation}
        onChange={(e) => edit('rotation', Number(e.target.value))} /></label>
    </div>
    <button className="button quiet" type="button" onClick={remove}>Remove {element.kind}</button>
  </fieldset>;
}

function RevisedQuote({ order, product, onSave }: { order: Order; product: Product; onSave: () => void }) {
  const [config, setConfig] = useState<Configuration>(order.config);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pricing = quoteView(product, config);
  const needsInrQuote = order.price.currency !== ORDER_CURRENCY;
  const unchanged = !needsInrQuote && order.product_snapshot.revision === product.revision &&
    JSON.stringify(config) === JSON.stringify(order.config);
  return <details className="panel config-change" open={needsInrQuote || undefined}>
    <summary>{needsInrQuote ? 'Update quote to INR' : 'Change print configuration'}</summary>
    <ConfigFields product={product} config={config} update={setConfig} />
    <Feedback error={error || pricing.error} />
    <div className="actions">
      {pricing.quote ? <b>{money(pricing.quote.total, pricing.quote.currency)} incl. tax</b> : null}
      <button className="button secondary" disabled={!pricing.quote || busy || unchanged}
        onClick={async () => {
          if (!pricing.quote) return;
          setError(''); setBusy(true);
          try {
            await api(`orders/${order.id}/configure`, { configuration: config, productRevision: product.revision,
              currency: pricing.quote.currency, total: pricing.quote.total, revision: order.revision });
            onSave();
          } catch (problem) { setError(message(problem)); }
          finally { setBusy(false); }
        }}>Accept revised quote</button>
    </div>
  </details>;
}

export function OrderEditor({ order, onSaved, staff }: { order: Order; onSaved: () => void; staff: boolean }) {
  const product = order.product_snapshot;
  const [design, setDesign] = useState<Design>(order.draft);
  const [csv, setCsv] = useState(order.draft_csv);
  const [mapping, setMapping] = useState(order.draft_mapping);
  const [header, setHeader] = useState<{ headers: string[]; count: number; examples: string[][] } | null>(null);
  const [csvProblem, setCsvProblem] = useState('');
  const [uploaded, setUploaded] = useState('');
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [row, setRow] = useState(0);
  const { catalogue } = useCatalogue();
  const currentProduct = catalogue.find(({ id }) => id === product.id);
  const sizes = printSize(order.config, product);
  const revision = order.revision;
  const payload = useMemo(() => ({ design, csv, mapping, revision }), [design, csv, mapping, revision]);
  const canPreview = !product.personalized || !!header && header.count === order.config.quantity;
  const rowCount = product.personalized ? header?.count ?? 0 : 1;

  useEffect(() => {
    let alive = true;
    if (!csv || !product.personalized) {
      setHeader(null);
      return;
    }
    api<typeof header>(`orders/${order.id}/inspect-csv`, { csv }).then((found) => {
      if (!alive || !found) return;
      setHeader(found); setCsvProblem('');
      setMapping((old) => {
        if (found.headers.includes(old.name) && found.headers.includes(old.number) && old.name !== old.number) return old;
        const name = found.headers.find((label) => /^(name|full.?name|runner)$/i.test(label)) ?? found.headers[0];
        const number = found.headers.find((label) => /^(number|bib|bib.?number)$/i.test(label) && label !== name)
          ?? found.headers.find((label) => label !== name)!;
        return { name, number };
      });
    }).catch((error: unknown) => { if (alive) { setHeader(null); setCsvProblem(message(error)); } });
    return () => { alive = false; };
  }, [csv, order.id, product.personalized]);

  useEffect(() => {
    if (!canPreview) { setPreview(''); setPreviewError(''); setPreviewBusy(false); return; }
    const cancel = new AbortController();
    let image = '';
    setPreviewBusy(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(endpoint(`orders/${order.id}/preview`), {
          method: 'POST', signal: cancel.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, row }),
        });
        if (!response.ok) throw new Error((await response.json()).error);
        const bytes = await response.blob();
        if (cancel.signal.aborted) return;
        image = URL.createObjectURL(bytes);
        setPreview(image); setPreviewError('');
      } catch (error) {
        if (!cancel.signal.aborted) { setPreview(''); setPreviewError(message(error)); }
      } finally { if (!cancel.signal.aborted) setPreviewBusy(false); }
    }, 220);
    return () => { cancel.abort(); clearTimeout(timer); if (image) URL.revokeObjectURL(image); };
  }, [order.id, payload, canPreview, row]);

  function editEditor(newDesign: Partial<EditorDesign>) {
    setDesign((old) => old.mode === 'editor' ? { ...old, ...newDesign } : old);
  }
  function addText() {
    if (design.mode !== 'editor') return;
    editEditor({ elements: [...design.elements, {
      kind: 'text', text: 'New text', font: 'mono', x: order.config.width / 2,
      y: order.config.height * .67, size: Math.max(1, order.config.height * .10), color: design.ink, rotation: 0,
    }] });
  }
  async function asset(file: File | undefined, kind: 'logo' | 'artwork') {
    if (!file) return;
    setBusy(true); setProblem('');
    try {
      const result = await upload(order.id, file, kind);
      setUploaded(file.name);
      if (kind === 'artwork') setDesign({ mode: 'upload', assetId: result.id });
      else if (design.mode === 'editor') {
        const width = Math.min(order.config.width / 3,
          (order.config.height - 2 * product.safeInset) * result.width / result.height * .6,
          result.width / product.ppi * 25.4);
        if (width < 1) throw new Error('The logo is too small. Upload a higher-resolution PNG.');
        editEditor({ elements: [...design.elements, { kind: 'logo', assetId: result.id,
          x: order.config.width / 2, y: order.config.height / 2, width, rotation: 0 }] });
      }
    } catch (error) { setProblem(message(error)); }
    finally { setBusy(false); }
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    setCsvProblem('');
    try {
      if (file.size > 256 * 1024) throw new Error('Upload a CSV of 256 KB or less.');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (source !== csv) setHeader(null);
      setRow(0);
      setCsv(source);
    } catch { setCsvProblem('Use a UTF-8 CSV of 256 KB or less. The previous data is still saved in this draft.'); }
  }

  async function submit(action: 'draft' | 'publish') {
    setBusy(true); setProblem('');
    try { await api(`orders/${order.id}/${action}`, payload); onSaved(); }
    catch (error) { setProblem(message(error)); }
    finally { setBusy(false); }
  }

  return <div className="editor-stack">
    {!staff && currentProduct ? <RevisedQuote order={order} product={currentProduct} onSave={onSaved} /> : null}
    <section className="panel">
      <div className="panel-head"><h2>Artwork</h2></div>
      {!product.personalized ? <div className="tabs" aria-label="Artwork source">
        <button type="button" aria-pressed={design.mode === 'editor'} onClick={() => {
          if (design.mode === 'upload') setDesign(order.draft.mode === 'editor' ? order.draft : defaultDesign(product));
        }}>Design artwork</button>
        <label className="tab-file">
          <span>{design.mode === 'upload' ? 'Replace artwork' : 'Upload finished artwork'}</span>
          <input type="file" accept=".png,.svg,.pdf,.ai" aria-label="Upload finished artwork" disabled={busy}
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; void asset(file, 'artwork'); }} />
        </label>
      </div> : null}
      {product.personalized ? <div className="csv-block">
        <div className="spread"><h3>Runner details</h3><a className="text-link" href="/samples/runners.csv" download>Sample CSV</a></div>
        <label className="field">Upload runner CSV<input type="file" accept=".csv,text/csv"
          onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; void readFile(file); }} />
          <small>One row per runner. Match the order quantity of {order.config.quantity}.</small></label>
        <Feedback error={csvProblem || (header && header.count !== order.config.quantity ? `${header.count} CSV rows for ${order.config.quantity} units. Correct the file or quantity.` : '')}
          info={header?.count === order.config.quantity ? `${header.count} rows loaded.` : undefined} />
        {header ? <div className="form-grid">
          <label className="field">Name column<select value={mapping.name} onChange={(e) => setMapping({ ...mapping, name: e.target.value })}>
            {header.headers.map((column) => <option key={column}>{column}</option>)}</select></label>
          <label className="field">Bib number column<select value={mapping.number} onChange={(e) => setMapping({ ...mapping, number: e.target.value })}>
            {header.headers.map((column) => <option key={column}>{column}</option>)}</select></label>
        </div> : null}
      </div> : null}
      {design.mode === 'editor' ? <>
        <div className="form-grid editor-palette">
          <label className="field">{product.personalized ? 'Event title' : 'Design title'}<input maxLength={80} value={design.title}
            onChange={(e) => editEditor({ title: e.target.value })} /></label>
          <label className="field">Background<input type="color" value={design.background} onChange={(e) => editEditor({ background: e.target.value })} /></label>
          <label className="field">Ink<input type="color" value={design.ink} onChange={(e) => editEditor({ ink: e.target.value })} /></label>
        </div>
        {design.elements.map((element, index) => <ElementFields key={index} element={element} index={index} order={order}
          set={(value) => editEditor({ elements: design.elements.map((item, i) => index === i ? value : item) })}
          remove={() => editEditor({ elements: design.elements.filter((_, i) => index !== i) })} />)}
        <div className="actions">
          <button type="button" className="button secondary" disabled={design.elements.length >= 20 || busy} onClick={addText}>Add text</button>
          <label className="tab-file button secondary"><span>Add logo</span><input type="file" aria-label="Add PNG logo" accept=".png,image/png"
            disabled={busy || design.elements.length >= 20} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; void asset(file, 'logo'); }} /></label>
        </div>
      </> : <p className="muted">Finished artwork at {sizes.widthPx} × {sizes.heightPx} px including bleed.</p>}
      <Feedback error={problem} info={uploaded ? `${uploaded} loaded.` : undefined} />
    </section>
    <section className="panel panel-preview">
      <div className="panel-head spread"><h2>Artwork preview</h2>{rowCount > 1 ? <label className="field compact-field">Preview row
        <select value={row} onChange={(e) => setRow(Number(e.target.value))}>{Array.from({ length: rowCount }, (_, index) =>
          <option key={index} value={index}>Row {index + 1}</option>)}</select></label> : null}</div>
      <div className="proof-canvas" aria-busy={previewBusy}>
        {preview && !previewBusy ? <img src={preview} alt="Current print artwork with trim and safe area guides" /> :
          <p role="status">{previewBusy ? 'Rendering preview…' : !canPreview ? 'Upload a matching CSV to preview the race bibs.' : 'Correct the artwork to see a preview.'}</p>}
      </div>
      <p className="muted spec-line">{order.config.width} × {order.config.height} mm trim · {product.bleed} mm bleed · dashed safe area</p>
      <Feedback error={previewError} />
      <div className="actions">
        <button className="button secondary" disabled={busy} onClick={() => void submit('draft')}>Save draft</button>
        <button className="button" disabled={busy || !canPreview || !!previewError || previewBusy || !preview}
          onClick={() => void submit('publish')}>{busy ? 'Saving…' : 'Publish proof'}</button>
      </div>
    </section>
  </div>;
}
