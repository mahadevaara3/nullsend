import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';
import { discovery } from './build/discovery';

// The single source of truth for what the app may talk to. connect-src 'self'
// means even a compromised dependency cannot send your files anywhere else:
// the browser refuses the request before it leaves the machine.
const csp = (scriptExtra = '') => [
  "default-src 'self'",
  // blob: is needed because the ONNX runtime loads its own module from a local blob URL.
  // A blob URL can only hold data this page already has, so it is not a way out.
  `script-src 'self' blob: 'wasm-unsafe-eval'${scriptExtra}`,
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const CSP = csp();
// The background remover's ndarray dependency compiles helpers with new Function(),
// so that page alone allows eval. Network rules are identical: eval can't reach
// a server that connect-src forbids.
const EVAL_PAGES = ['/tools/background-remover/'];
const CSP_EVAL = csp(" 'unsafe-eval'");

// Cross-origin isolation unlocks SharedArrayBuffer, so the ONNX runtime can use threads.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function securityHeaders(): Plugin {
  return {
    name: 'nullsend-security-headers',
    transformIndexHtml: (_html, ctx) => {
      const content = EVAL_PAGES.some((p) => ctx.path.startsWith(p)) ? CSP_EVAL : CSP;
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content }, injectTo: 'head-prepend' }];
    },
    // _headers is read by Cloudflare Pages and Netlify. Unlike the meta tag, a real
    // header also covers web workers and adds frame-ancestors.
    generateBundle() {
      const headers = { 'Content-Security-Policy': `${CSP}; frame-ancestors 'none'`, ...ISOLATION,
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()' };
      const body = Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
      // "! Header" detaches the global value (Cloudflare Pages syntax) so the override replaces it.
      const overrides = EVAL_PAGES.map((p) =>
        `${p}*\n  ! Content-Security-Policy\n  Content-Security-Policy: ${CSP_EVAL}; frame-ancestors 'none'\n`).join('');
      this.emitFile({ type: 'asset', fileName: '_headers', source: `/*\n${body}\n${overrides}` });
    },
  };
}

// Set BASE_PATH=/nullsend/ when deploying to a GitHub Pages project site.
const base = process.env.BASE_PATH ?? '/';
// The public address used in canonical links, the sitemap and llms.txt.
const site = process.env.SITE_URL ?? 'https://mahadevaara3.github.io/nullsend/';

export default defineConfig({
  base,
  server: { headers: ISOLATION },
  preview: { headers: ISOLATION },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        metadata: resolve(import.meta.dirname, 'tools/metadata/index.html'),
        background: resolve(import.meta.dirname, 'tools/background-remover/index.html'),
        redact: resolve(import.meta.dirname, 'tools/redact/index.html'),
      },
    },
  },
  plugins: [
    securityHeaders(),
    discovery(site, base),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      manifest: {
        name: 'Nullsend: private file tools',
        short_name: 'Nullsend',
        description: 'File tools that run entirely in your browser. Nothing is uploaded.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [{ src: `${base}icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{html,js,css,svg,txt,xml}'],
        globIgnores: ['vendor/**'],
        navigateFallback: null,
        // Models are large and only needed by the tool that uses them, so they are
        // cached the first time that tool runs instead of on install.
        runtimeCaching: [{
          urlPattern: ({ url }) => url.pathname.startsWith(`${base}vendor/`),
          handler: 'CacheFirst',
          options: { cacheName: 'nullsend-vendor', expiration: { maxEntries: 64 } },
        }],
      },
    }),
  ],
});
