'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { configurationSchema, defaultConfiguration, quoteProduct, referenceSize, seedCatalogue, type Configuration, type Product, type Quote } from '@/domain/catalogue';
import { api, Feedback, Loading, message, QuoteSummary, useLoad, useSession } from './ui';

const sampleText: Record<string, string> = { stickers: 'Morning Club', race: '007', mtb: '48', stamps: 'PACKED TODAY', trophies: 'FIRST PLACE', laser: 'Field Notes' };
function Sample({ product }: { product: Product }) {
  return <figure className={`sample sample-${product.id}`} aria-label={`${product.title} template sample`}>
    <div className="sample-object">
      {product.id === 'race' ? <span className="sample-stripe">CITY LOOP RUN</span> : null}
      <strong>{sampleText[product.id] ?? product.sample}</strong>
      {product.id === 'race' ? <span className="sample-runner">MAYA PATEL</span> : null}
    </div>
  </figure>;
}

export function useCatalogue() {
  const { data, error, loading } = useLoad<Product[]>('catalogue');
  const liveCatalogue = data ? [...data].sort((a, b) => {
    const index = (id: string) => { const position = seedCatalogue.findIndex((product) => product.id === id); return position < 0 ? 99 : position; };
    return index(a.id) - index(b.id);
  }) : seedCatalogue;
  return { catalogue: liveCatalogue, error, loading };
}

export function Storefront() {
  const { catalogue } = useCatalogue();
  const [gallery, setGallery] = useState('');
  return <>
    <section className="hero">
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <h1>Custom print,<br />down to the millimetre.</h1>
          <p>Set your size and quantity, build your artwork, and check the proof before it goes to press.</p>
          <a className="button" href="#products">Choose a product</a>
        </div>
        <figure className="hero-image" aria-label="Illustrated race bib and sticker template samples">
          <div className="hero-ruler" aria-hidden="true" />
          <div className="hero-sticker"><strong>Morning<br />Club</strong></div>
          <div className="hero-bib">
            <span>CITY LOOP RUN</span><b>007</b><strong>MAYA PATEL</strong>
          </div>
          <figcaption>Race bib and vinyl sticker samples</figcaption>
        </figure>
      </div>
    </section>
    <section id="products" className="wrap product-section">
      <div className="section-head"><h2>Print products</h2><span className="muted">Custom sizes and live pricing</span></div>
      <div className="products">
        {catalogue.map((product) => <Link key={product.id} href={`/products/${product.id}`} className="product-card">
          <Sample product={product} />
          <div className="product-content"><h3>{product.title}</h3><p>{product.description}</p><span className="product-link">Configure &amp; price</span></div>
        </Link>)}
      </div>
    </section>
    <section id="gallery" className="gallery">
      <div className="wrap">
        <div className="section-head"><div><h2>Sample artwork</h2><p className="muted">Proofs from the shop’s demo templates.</p></div>
          <label className="field compact-field">Filter by product
            <select value={gallery} onChange={(event) => setGallery(event.target.value)}>
              <option value="">All products</option>
              {catalogue.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
            </select>
          </label>
        </div>
        <div className="gallery-grid">
          {catalogue.filter(({ id }) => !gallery || id === gallery).map(({ id, title }) => <figure className="gallery-sample" key={id}>
            <div><img src={`/samples/artwork/${id}.webp`} alt={`${title} print proof`} loading="lazy" decoding="async" /></div>
            <figcaption>{title}</figcaption>
          </figure>)}
        </div>
      </div>
    </section>
  </>;
}

const savedConfiguration = (id: string) => `dh:quote:${id}`;

export function ConfigFields({ product, config, update }: { product: Product; config: Configuration; update: (input: Configuration) => void }) {
  const [w, h] = referenceSize(product, config.orientation);
  return <div className="form-grid">
    <label className="field">Material<select value={config.material} onChange={(e) => update({ ...config, material: e.target.value })}>
      {product.materials.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}</select></label>
    <label className="field">Orientation<select value={config.orientation} onChange={(e) => {
      const orientation = e.target.value as Configuration['orientation'];
      update({ ...config, orientation, width: config.height, height: config.width });
    }}><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select></label>
    <label className="field">Width (mm)<input required type="number" min={Math.ceil(w / 2)} max={w * 2} value={config.width || ''}
      onChange={(e) => update({ ...config, width: Number(e.target.value) })} /><small>{Math.ceil(w / 2)}–{w * 2} mm</small></label>
    <label className="field">Height (mm)<input required type="number" min={Math.ceil(h / 2)} max={h * 2} value={config.height || ''}
      onChange={(e) => update({ ...config, height: Number(e.target.value) })} /><small>{Math.ceil(h / 2)}–{h * 2} mm</small></label>
    <label className="field">Quantity<input required type="number" min={1} max={1000} value={config.quantity || ''}
      onChange={(e) => update({ ...config, quantity: Number(e.target.value) })} /><small>Save 10% from 100 units and 15% from 500</small></label>
  </div>;
}

export function quoteView(product: Product, config: Configuration): { quote: Quote | null; error: string } {
  if (!configurationSchema.safeParse(config).success) return { quote: null, error: '' };
  try { return { quote: quoteProduct(product, config), error: '' }; }
  catch (error) { return { quote: null, error: message(error) }; }
}

function QuoteForm({ product, available }: { product: Product; available: boolean }) {
  const [config, setConfig] = useState(() => defaultConfiguration(product));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { account, loading } = useSession();
  const router = useRouter();
  const pricing = quoteView(product, config);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(savedConfiguration(product.id));
      if (!saved) return;
      const parsed = configurationSchema.safeParse(JSON.parse(saved));
      if (parsed.success && parsed.data.productId === product.id) setConfig(parsed.data);
    } catch { /* An unavailable session store can be ignored. */ }
  }, [product.id]);

  async function proceed(event: FormEvent) {
    event.preventDefault();
    if (!pricing.quote) return;
    setError('');
    try { localStorage.setItem(savedConfiguration(product.id), JSON.stringify(config)); } catch {}
    if (!account) {
      router.push(`/account?next=${encodeURIComponent(`/products/${product.id}`)}`);
      return;
    }
    setBusy(true);
    try {
      const fingerprint = JSON.stringify({ configuration: config, total: pricing.quote.total, productRevision: product.revision });
      const keyName = `${savedConfiguration(product.id)}:confirmation`;
      let key = crypto.randomUUID();
      try {
        const prior = JSON.parse(sessionStorage.getItem(keyName) ?? 'null');
        if (prior?.fingerprint === fingerprint && typeof prior.key === 'string') key = prior.key;
        sessionStorage.setItem(keyName, JSON.stringify({ fingerprint, key }));
      } catch {}
      const order = await api<{ id: string }>('orders', { ...JSON.parse(fingerprint), key });
      try { sessionStorage.removeItem(keyName); } catch {}
      router.push(`/orders/${order.id}`);
    } catch (problem) { setError(message(problem)); }
    finally { setBusy(false); }
  }
  return <form className="two-col" onSubmit={proceed}>
    <section className="panel">
      <div className="panel-head"><h2>Print specifications</h2></div>
      <ConfigFields product={product} config={config} update={(value) => { setConfig(value); setError(''); }} />
      <div className="specs"><span>{product.ppi} ppi</span><span>{product.bleed} mm bleed</span><span>Shop collection</span></div>
      <Feedback error={pricing.error || error} />
    </section>
    <QuoteSummary quote={pricing.quote}>
      <button className="button full" disabled={!available || !pricing.quote || loading || busy || account?.role === 'staff'}>
        {busy ? 'Creating order…' : account ? 'Create order' : 'Sign in to order'}
      </button>
      {account?.role === 'staff' ? <p className="muted">Use a customer account to create an order.</p> : null}
    </QuoteSummary>
  </form>;
}

export function ConfigureScreen({ productId }: { productId: string }) {
  const { catalogue, error, loading } = useCatalogue();
  const product = catalogue.find(({ id }) => id === productId);
  if (!product) return <section className="wrap page-head">{loading ? <Loading /> : <><h1>Product unavailable</h1><Link href="/#products">Browse products</Link></>}</section>;
  return <div className="wrap screen">
    <div className="page-head compact"><Link className="back" href="/#products">Print products</Link>
      <h1>{product.title}</h1><p>{product.description}</p></div>
    <Feedback error={error} />
    <QuoteForm product={product} available={!error && !loading} />
  </div>;
}
