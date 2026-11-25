import type { NextConfig } from 'next';

const config: NextConfig = {
  agentRules: false,
  devIndicators: false,
  serverExternalPackages: ['@electric-sql/pglite', '@hyzyla/pdfium', 'fontkit', 'pg', 'sharp'],
  outputFileTracingIncludes: {
    '/api/print/**/*': ['./supabase/migrations/*.sql', './assets/fonts/*'],
  },
  outputFileTracingExcludes: {
    '/*': ['./.data/**/*', './test-results/**/*', './.env*'],
  },
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
};

export default config;
