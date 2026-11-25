import Link from 'next/link';

export default function NotFound() {
  return <section className="page-head wrap">
    <h1>Page unavailable</h1>
    <p>Check the address or choose a print product to get started.</p>
    <Link className="button" href="/">Browse products</Link>
  </section>;
}
