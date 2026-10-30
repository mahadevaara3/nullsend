import { createWorker, OEM, type Worker as OcrWorker } from 'tesseract.js';
import { BASE, mountShell } from '../../core/shell';
import { canvasToBlob, dropZone, download, escapeHtml, withSuffix } from '../../core/files';
import { detect, type Box, type Word } from './detect';
import './redact.css';

mountShell('redact');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = $('drop');
const status = $('status');
const statusText = $('status-text');
const bar = $('bar');
const scanImg = $<HTMLImageElement>('scan-img');
const editor = $('editor');
const canvas = $<HTMLCanvasElement>('canvas');
const list = $<HTMLUListElement>('list');
const ctx = canvas.getContext('2d')!;

interface Redaction { id: number; type: string; text: string; box: Box; on: boolean }
let image: ImageBitmap | null = null;
let fileName = 'screenshot.png';
let redactions: Redaction[] = [];
let style: 'solid' | 'pixelate' = 'solid';
let nextId = 1;
let worker: Promise<OcrWorker> | null = null;

function setStatus(text: string, fraction?: number) {
  status.hidden = false;
  status.classList.remove('failed');
  statusText.textContent = text;
  if (fraction !== undefined) bar.style.width = `${Math.round(fraction * 100)}%`;
}

// Engine, language data and worker script are all served from this site.
function getWorker(): Promise<OcrWorker> {
  worker ??= createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: `${BASE}vendor/tesseract/worker.min.js`,
    corePath: `${BASE}vendor/tesseract/core`,
    langPath: `${BASE}vendor/tesseract/lang`,
    workerBlobURL: false,
    logger: (m) => {
      const label = m.status === 'recognizing text' ? 'Reading the text on your device…' : 'Loading the text recognizer from this site…';
      setStatus(label, m.progress);
    },
  });
  return worker;
}

dropZone(drop, { accept: 'image/png,image/jpeg,image/webp', onFiles: ([f]) => run(f) });

async function run(file: File) {
  fileName = file.name;
  drop.classList.add('compact');
  editor.hidden = true;
  URL.revokeObjectURL(scanImg.src);
  scanImg.src = URL.createObjectURL(file);
  setStatus('Starting…', 0);
  try {
    image?.close();
    image = await createImageBitmap(file);
    canvas.width = image.width;
    canvas.height = image.height;
    const ocr = await getWorker();
    const { data } = await ocr.recognize(file, {}, { blocks: true });
    const lines: Word[][] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) for (const line of para.lines) lines.push(line.words);
    }
    redactions = detect(lines).map((d) => ({ id: nextId++, ...d, on: true }));
    status.hidden = true;
    editor.hidden = false;
    render();
  } catch (e) {
    setStatus(`Something went wrong: ${(e as Error).message}`);
    status.classList.add('failed');
  }
}

function pixelate(b: Box) {
  // Few, large blocks: enough to hide the content, unlike a light blur.
  const cell = Math.max(12, Math.ceil(b.h / 2));
  const w = Math.max(1, Math.ceil(b.w / cell)), h = Math.max(1, Math.ceil(b.h / cell));
  const tmp = new OffscreenCanvas(w, h);
  const t = tmp.getContext('2d')!;
  t.drawImage(canvas, b.x, b.y, b.w, b.h, 0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, w, h, b.x, b.y, b.w, b.h);
  ctx.imageSmoothingEnabled = true;
}

// The canvas is always exactly what gets exported. No overlay sits on top.
function paint(preview: Box | null = null) {
  if (!image) return;
  ctx.drawImage(image, 0, 0);
  for (const r of redactions) {
    if (!r.on) continue;
    if (style === 'solid') { ctx.fillStyle = '#000'; ctx.fillRect(r.box.x, r.box.y, r.box.w, r.box.h); }
    else pixelate(r.box);
  }
  if (preview) {
    ctx.save();
    ctx.strokeStyle = '#14b8a6';
    ctx.lineWidth = Math.max(2, canvas.width / 600);
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(preview.x, preview.y, preview.w, preview.h);
    ctx.restore();
  }
}

function render() {
  paint();
  list.innerHTML = redactions.length ? redactions.map((r) => `
    <li class="${r.on ? '' : 'off'}" data-id="${r.id}">
      <input type="checkbox" ${r.on ? 'checked' : ''} aria-label="Redact ${escapeHtml(r.type)}" />
      <div class="what"><b>${escapeHtml(r.type)}</b><span title="${escapeHtml(r.text)}">${escapeHtml(r.text)}</span></div>
      <button type="button" aria-label="Remove">✕</button>
    </li>`).join('')
    : '<li><div class="what"><span>Nothing sensitive detected.</span></div></li>';
}

list.addEventListener('change', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  const r = redactions.find((x) => x.id === Number(li?.dataset.id));
  if (r) { r.on = (e.target as HTMLInputElement).checked; render(); }
});
list.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).matches('button')) return;
  const id = Number((e.target as HTMLElement).closest('li')?.dataset.id);
  redactions = redactions.filter((r) => r.id !== id);
  render();
});

document.querySelectorAll<HTMLButtonElement>('[data-style]').forEach((b) => b.addEventListener('click', () => {
  style = b.dataset.style as typeof style;
  document.querySelectorAll('[data-style]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  $('style-note').textContent = style === 'solid'
    ? 'Solid boxes are the safest choice: nothing underneath survives.'
    : 'Pixelated text can sometimes be guessed back. Use solid for passwords, keys and numbers.';
  paint();
}));

// Drag to add a box.
let dragStart: { x: number; y: number } | null = null;
const toImage = (e: PointerEvent) => {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
};
const boxFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Box =>
  ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

canvas.addEventListener('pointerdown', (e) => { dragStart = toImage(e); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => { if (dragStart) paint(boxFrom(dragStart, toImage(e))); });
canvas.addEventListener('pointerup', (e) => {
  if (!dragStart) return;
  const box = boxFrom(dragStart, toImage(e));
  dragStart = null;
  if (box.w > 4 && box.h > 4) redactions.push({ id: nextId++, type: 'Manual', text: `${Math.round(box.w)} × ${Math.round(box.h)} px`, box, on: true });
  render();
});

const output = () => canvasToBlob(canvas, 'image/png');
const outName = () => withSuffix(fileName, 'redacted', 'png');

$('save').addEventListener('click', async () => download(await output(), outName()));
$('copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': output() })]);
    btn.textContent = 'Copied ✓';
  } catch {
    btn.textContent = 'Not supported';
  }
  setTimeout(() => (btn.textContent = 'Copy'), 1800);
});

// The native share sheet hands the finished image to the app you pick; this site never sees it.
const share = $<HTMLButtonElement>('share');
share.hidden = !navigator.canShare?.({ files: [new File([], 'x.png', { type: 'image/png' })] });
share.addEventListener('click', async () => {
  const file = new File([await output()], outName(), { type: 'image/png' });
  await navigator.share({ files: [file] }).catch(() => {});
});
