import './styles.css';
import './theme.css';
import { installMeter, mountMeter } from './meter';
import { REPO_URL, TOOLS, type ToolId } from '../catalog';

// Installed at import time, before any tool code runs, so the meter sees every request.
installMeter();

// The site may be served from a sub-path (GitHub Pages: /nullsend/), so every
// internal link is built from Vite's base URL.
export const BASE = import.meta.env.BASE_URL;

export function mountShell(current?: ToolId) {
  const header = document.createElement('header');
  header.className = 'site-header';
  header.innerHTML = `
    <div class="wrap">
      <a class="brand" href="${BASE}"><img src="${BASE}icon.svg" alt="" />Nullsend</a>
      <nav class="nav" aria-label="Tools">
        ${TOOLS.map((t) => `<a href="${BASE}${t.path}"${t.id === current ? ' aria-current="page"' : ''}>${t.name}</a>`).join('')}
      </nav>
      <div id="meter"></div>
    </div>`;
  document.body.prepend(header);
  mountMeter(header.querySelector('#meter')!);

  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = `
    <div class="wrap">
      <span>Nullsend runs entirely in your browser. No uploads, no accounts, no analytics.</span>
      <span><a href="${BASE}#verify">How to verify</a> · <a href="${REPO_URL}" rel="noreferrer">Source code</a> · AGPL-3.0</span>
    </div>`;
  document.body.append(footer);
}
