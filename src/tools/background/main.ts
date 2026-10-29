import { removeBackground, type Config } from '@imgly/background-removal';
import { BASE, mountShell } from '../../core/shell';
import { canvasToBlob, dropZone, download, withSuffix } from '../../core/files';
import { formatBytes } from '../../core/meter';
import './background.css';

mountShell('background');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = $('drop');
const status = $('status');
const statusText = $('status-text');
const bar = $('bar');
const editor = $('editor');
const before = $<HTMLImageElement>('before');
const after = $<HTMLCanvasElement>('after');
const split = $<HTMLInputElement>('split');
const handle = $('handle');
const color = $<HTMLInputElement>('color');

type Bg = 'transparent' | 'color' | 'blur';
let bg: Bg = 'transparent';
let source: { file: File; original: ImageBitmap; cutout: ImageBitmap } | null = null;

// The model and ONNX runtime are served from this site (see scripts/vendor.mjs),
// so the default third-party CDN is never contacted.
const config: Config = {
  publicPath: new URL(`${BASE}vendor/imgly/`, location.href).href,
  model: 'isnet_quint8',
  device: 'cpu',
  output: { format: 'image/png', quality: 1 },
  progress: (key, current, total) => {
    if (key.startsWith('fetch:')) {
      setStatus(`Loading the model from this site: ${formatBytes(current)} of ${formatBytes(total)} (one time only)`, current / total);
    } else if (key.startsWith('compute:')) {
      setStatus('Finding the subject on your device…', current / Math.max(total, 1));
    }
  },
};

function setStatus(text: string, fraction?: number) {
  status.hidden = false;
  statusText.textContent = text;
  if (fraction !== undefined) bar.style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
}

dropZone(drop, { accept: 'image/jpeg,image/png,image/webp', onFiles: ([f]) => run(f) });

async function run(file: File) {
  drop.classList.add('compact');
  editor.hidden = true;
  setStatus('Starting…', 0);
  const t0 = performance.now();
  try {
    const cutoutBlob = await removeBackground(file, config);
    const [original, cutout] = await Promise.all([createImageBitmap(file), createImageBitmap(cutoutBlob)]);
    source?.original.close();
    source?.cutout.close();
    source = { file, original, cutout };
    $('timing').textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s on this device`;
    before.src = URL.createObjectURL(file);
    status.hidden = true;
    editor.hidden = false;
    draw();
  } catch (e) {
    setStatus(`Something went wrong: ${(e as Error).message}`);
  }
}

function draw() {
  if (!source) return;
  const { original, cutout } = source;
  after.width = cutout.width;
  after.height = cutout.height;
  const ctx = after.getContext('2d')!;
  ctx.clearRect(0, 0, after.width, after.height);
  if (bg === 'color') {
    ctx.fillStyle = color.value;
    ctx.fillRect(0, 0, after.width, after.height);
  } else if (bg === 'blur') {
    // Portrait-mode look: the original, heavily blurred, behind the sharp subject.
    const r = Math.round(Math.max(after.width, after.height) / 60);
    ctx.filter = `blur(${r}px)`;
    ctx.drawImage(original, -r, -r, after.width + 2 * r, after.height + 2 * r);
    ctx.filter = 'none';
  }
  ctx.drawImage(cutout, 0, 0);
  updateSplit();
}

function updateSplit() {
  const v = Number(split.value);
  after.style.clipPath = `inset(0 0 0 ${v}%)`;
  handle.style.left = `${v}%`;
}

split.addEventListener('input', updateSplit);
color.addEventListener('input', () => { setBg('color'); });
document.querySelectorAll<HTMLButtonElement>('[data-bg]').forEach((b) =>
  b.addEventListener('click', () => setBg(b.dataset.bg as Bg)));

function setBg(next: Bg) {
  bg = next;
  document.querySelectorAll<HTMLButtonElement>('[data-bg]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.bg === bg)));
  draw();
}

$('save').addEventListener('click', async () => {
  if (!source) return;
  download(await canvasToBlob(after), withSuffix(source.file.name, bg === 'transparent' ? 'cutout' : 'edited', 'png'));
});

$('copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToBlob(after) })]);
    btn.textContent = 'Copied ✓';
  } catch {
    btn.textContent = 'Copy not supported';
  }
  setTimeout(() => (btn.textContent = 'Copy to clipboard'), 1800);
});

$('another').addEventListener('click', () => drop.click());
