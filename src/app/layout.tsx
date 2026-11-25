import type { Metadata } from 'next';
import { Interactivity } from '@/web/ui';
import '@fontsource-variable/manrope';
import '@fontsource/ibm-plex-mono/400.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Digital Heroes Print', template: '%s | Digital Heroes Print' },
  description: 'Configure custom print, approve your proof and track your order.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en-IN" data-scroll-behavior="smooth"><body><Interactivity>{children}</Interactivity></body></html>;
}
