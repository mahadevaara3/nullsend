import './styles.css';
import { installMeter, mountMeter } from './meter';

// Installed at import time, before any tool code runs, so the meter sees every request.
installMeter();

// Point this at your public repository once it exists.
export const REPO_URL = 'https://github.com/mahadevaara3/nullsend';

export const TOOLS = [
  {
    id: 'metadata',
    href: '/tools/metadata/',
    icon: '🔍',
    name: 'Metadata X-ray',
    tag: 'Photos',
    blurb: 'See the GPS location, camera serial number and AI/C2PA markers hidden in a photo, then remove them without re-encoding.',
  },
  {
    id: 'background',
    href: '/tools/background-remover/',
    icon: '✂️',
    name: 'Background remover',
    tag: 'AI · on-device',
    blurb: 'Cut out the subject of any photo with a neural network that runs on your own machine. Export a transparent PNG.',
  },
  {
    id: 'redact',
    href: '/tools/redact/',
    icon: '🕶️',
    name: 'Redact & Share',
    tag: 'Screenshots',
    blurb: 'Finds emails, phone numbers, card numbers and API keys in a screenshot with on-device OCR, and blacks them out.',
  },
] as const;

export function mountShell(current?: (typeof TOOLS)[number]['id']) {
  const header = document.createElement('header');
  header.className = 'site-header';
  header.innerHTML = `
    <div class="wrap">
      <a class="brand" href="/"><img src="/icon.svg" alt="" />Nullsend</a>
      <nav class="nav" aria-label="Tools">
        ${TOOLS.map((t) => `<a href="${t.href}"${t.id === current ? ' aria-current="page"' : ''}>${t.name}</a>`).join('')}
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
      <span><a href="/#verify">How to verify</a> · <a href="${REPO_URL}" rel="noreferrer">Source code</a> · AGPL-3.0</span>
    </div>`;
  document.body.append(footer);
}
