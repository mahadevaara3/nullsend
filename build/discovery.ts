import type { Plugin } from 'vite';
import { REPO_URL, SITE_NAME, TAGLINE, TOOLS } from '../src/catalog';

// Makes the site easy to find for search engines and AI agents: canonical URLs,
// Open Graph tags and JSON-LD on every page, plus sitemap.xml, robots.txt and
// llms.txt at the site root. All of it is static, so crawlers that don't run
// JavaScript see the same content as people do.

const GOOGLE_SITE_VERIFICATION = 'IZbejoesDXuu2BaDky4puUV2317mw6PRWAwMqmXrSA8';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function discovery(site: string, base: string): Plugin {
  const url = (path: string) => new URL(path, site).href;

  return {
    name: 'nullsend-discovery',
    transformIndexHtml(html, ctx) {
      // ctx.path is e.g. "/index.html" or "/tools/metadata/index.html".
      const path = ctx.path.replace(/^\//, '').replace(/index\.html$/, '');
      const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? SITE_NAME;
      const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? TAGLINE;
      const tool = TOOLS.find((t) => t.path === path);

      const data = tool
        ? {
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: tool.name,
            description: tool.blurb,
            url: url(path),
            applicationCategory: tool.category,
            operatingSystem: 'Any (runs in a web browser)',
            browserRequirements: 'Requires JavaScript and WebAssembly',
            isAccessibleForFree: true,
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            featureList: tool.features,
            isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: url('') },
            license: 'https://www.gnu.org/licenses/agpl-3.0.html',
            codeRepository: REPO_URL,
          }
        : {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: SITE_NAME,
            description: TAGLINE,
            url: url(''),
            hasPart: TOOLS.map((t) => ({ '@type': 'WebApplication', name: t.name, url: url(t.path) })),
          };

      // Static content generated from the catalog, so it is in the HTML itself.
      const out = html
        .replace('<!--tool-cards-->', TOOLS.map((t) => `
          <a class="card tool-card" href="${base}${t.path}">
            <span class="icon" aria-hidden="true">${t.icon}</span>
            <span class="tag">${esc(t.tag)}</span>
            <h3>${esc(t.name)}</h3>
            <p>${esc(t.blurb)}</p>
          </a>`).join(''))
        .replace('<!--tool-features-->', tool ? `<ul>${tool.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '');

      return { html: out, tags: [
        { tag: 'link', attrs: { rel: 'canonical', href: url(path) }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'robots', content: 'index, follow' }, injectTo: 'head' },
        // Search Console ownership (HTML-tag method; the HTML-file method is public/google*.html).
        { tag: 'meta', attrs: { name: 'google-site-verification', content: GOOGLE_SITE_VERIFICATION }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:type', content: 'website' }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:site_name', content: SITE_NAME }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:title', content: title }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:description', content: description }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:url', content: url(path) }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary' }, injectTo: 'head' },
        // JSON-LD is data, not script, so the CSP doesn't apply to it.
        { tag: 'script', attrs: { type: 'application/ld+json' }, children: JSON.stringify(data), injectTo: 'head' },
      ] };
    },

    generateBundle() {
      const today = new Date().toISOString().slice(0, 10);
      const pages = ['', ...TOOLS.map((t) => t.path)];
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${esc(url(p))}</loc><lastmod>${today}</lastmod></url>`).join('\n')}
</urlset>
`;
      // Open to every crawler, including AI search agents.
      const robots = `User-agent: *\nAllow: /\n\nSitemap: ${url('sitemap.xml')}\n`;
      // https://llmstxt.org: a plain summary an agent can read in one request.
      const llms = `# ${SITE_NAME}

> ${TAGLINE}

${SITE_NAME} is a set of free, open-source file tools. Every tool runs entirely in the visitor's browser with WebAssembly: files are never uploaded to a server. A Content-Security-Policy of \`connect-src 'self'\` makes the browser block any attempt to send data to another site, and a live network meter on every page shows bytes uploaded (always 0). It works offline as an installable web app. No account, no tracking.

## Tools

${TOOLS.map((t) => `- [${t.name}](${url(t.path)}): ${t.blurb}\n${t.features.map((f) => `  - ${f}`).join('\n')}`).join('\n')}

## How to verify the privacy claim

- [How to verify](${url('')}#verify): watch the network meter, go offline, read the security policy, read the code.

## Source

- [Source code on GitHub](${REPO_URL}): AGPL-3.0, TypeScript + Vite, no server component.
`;
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap });
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robots });
      this.emitFile({ type: 'asset', fileName: 'llms.txt', source: llms });
    },
  };
}
