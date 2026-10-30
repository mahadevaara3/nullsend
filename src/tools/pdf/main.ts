import { mountShell } from '../../core/shell';
import { dropZone, download, escapeHtml, withSuffix, canvasToBlob } from '../../core/files';
import { formatBytes } from '../../core/meter';
import { zip } from '../../core/zip';
import { build, loadImage, loadPdf, verify, type PageRef, type PageSize, type Source } from './engine';
import { closeSource, renderPage } from './render';
import './pdf.css';

mountShell('pdf');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = $('drop');
const status = $('status');
const board = $('board');
const grid = $('pages');
const result = $('result');
const buttons = ['save', 'split', 'images', 'rotate', 'delete'].map((id) => $<HTMLButtonElement>(id));

interface Tile extends PageRef { el: HTMLElement; selected: boolean }
let tiles: Tile[] = [];
const sources: Source[] = [];

function setStatus(text: string, fraction?: number, thumb?: HTMLCanvasElement) {
  status.hidden = false;
  status.classList.remove('failed');
  $('status-text').textContent = text;
  if (fraction !== undefined) $('bar').style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
  if (thumb) $<HTMLImageElement>('scan-img').src = thumb.toDataURL('image/jpeg', 0.6);
}
function fail(e: unknown) {
  setStatus(`Something went wrong: ${(e as Error).message}`);
  status.classList.add('failed');
}

dropZone(drop, {
  accept: 'application/pdf,.pdf,image/jpeg,image/png,image/webp',
  multiple: true,
  onFiles: (files) => addFiles(files),
});

async function addFiles(files: File[]) {
  drop.classList.add('compact');
  for (const [i, file] of files.entries()) {
    setStatus(`Reading ${file.name}…`, i / files.length);
    try {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const src = isPdf ? await loadPdf(file.name, new Uint8Array(await file.arrayBuffer())) : await loadImage(file);
      sources.push(src);
      for (let p = 0; p < src.pageCount; p++) tiles.push(makeTile({ src, index: p, rotate: 0 }));
    } catch (e) {
      fail(new Error(`${file.name}: ${(e as Error).message}`));
      return;
    }
  }
  status.hidden = true;
  board.hidden = false;
  refresh();
  renderThumbs();
}

function makeTile(ref: PageRef): Tile {
  const el = document.createElement('div');
  el.className = 'pg';
  el.tabIndex = 0;
  el.innerHTML = `<div class="pg-frame"></div><div class="pg-cap"><b></b><span>${escapeHtml(ref.src.name)}</span></div>`;
  const tile: Tile = { ...ref, el, selected: false };
  attachDrag(tile);
  return tile;
}

// Thumbnails render one at a time so a 300-page file doesn't hold up the page.
let renderQueue: Tile[] = [];
let rendering = false;
function renderThumbs(only?: Tile[]) {
  renderQueue.push(...(only ?? tiles.filter((t) => !t.el.querySelector('canvas'))));
  if (rendering) return;
  rendering = true;
  (async () => {
    while (renderQueue.length) {
      const t = renderQueue.shift()!;
      if (!tiles.includes(t)) continue;
      try {
        const c = await renderPage(t, { width: 150 });
        t.el.querySelector('.pg-frame')!.replaceChildren(c);
      } catch {
        t.el.querySelector('.pg-frame')!.textContent = 'Preview unavailable';
      }
    }
    rendering = false;
  })();
}

function refresh() {
  grid.replaceChildren(...tiles.map((t) => t.el));
  tiles.forEach((t, i) => {
    t.el.querySelector('b')!.textContent = String(i + 1);
    t.el.classList.toggle('selected', t.selected);
    t.el.setAttribute('aria-pressed', String(t.selected));
  });
  const sel = selected().length;
  $('count').textContent = `${tiles.length} page${tiles.length === 1 ? '' : 's'}${sel ? ` · ${sel} selected` : ''}`;
  $<HTMLButtonElement>('rotate').disabled = !sel;
  $<HTMLButtonElement>('delete').disabled = !sel;
  $('select-all').textContent = sel === tiles.length && sel ? 'Select none' : 'Select all';
  $('save').textContent = sel ? `Download ${sel} page${sel === 1 ? '' : 's'} as PDF` : 'Download PDF';
  $('size-opt').hidden = !tiles.some((t) => t.src.kind === 'image');
  for (const b of buttons.slice(0, 3)) b.disabled = !tiles.length;

  const found = sources.filter((s) => tiles.some((t) => t.src === s) && s.found.length);
  $('found-card').hidden = !found.length;
  $('found').innerHTML = found.map((s) => `<p><b>${escapeHtml(s.name)}</b></p>
    <ul class="found">${s.found.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`).join('');
}

const selected = () => tiles.filter((t) => t.selected);
const targets = () => (selected().length ? selected() : tiles);

$('select-all').addEventListener('click', () => {
  const all = selected().length !== tiles.length;
  tiles.forEach((t) => (t.selected = all));
  refresh();
});
$('rotate').addEventListener('click', () => {
  const sel = selected();
  sel.forEach((t) => (t.rotate = (t.rotate + 90) % 360));
  renderThumbs(sel);
  result.replaceChildren();
});
$('delete').addEventListener('click', () => {
  tiles = tiles.filter((t) => !t.selected);
  for (const s of sources.filter((s) => !tiles.some((t) => t.src === s))) {
    sources.splice(sources.indexOf(s), 1);
    closeSource(s);
  }
  result.replaceChildren();
  if (!tiles.length) { board.hidden = true; drop.classList.remove('compact'); }
  refresh();
});

// ---------- Reordering ----------
// Mouse and pen drag straight away. Touch needs a short hold, so a swipe still scrolls.

function attachDrag(tile: Tile) {
  const el = tile.el;
  // Listeners go on window: re-ordering moves this element in the DOM, which would drop pointer capture.
  el.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    let armed = down.pointerType !== 'touch';
    let dragging = false;
    let done = false;
    const timer = armed ? 0 : window.setTimeout(() => { armed = true; el.classList.add('armed'); navigator.vibrate?.(15); }, 350);
    const move = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      const moved = Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > 6;
      if (!armed) { if (moved) finish(false); return; } // a swipe: let the page scroll
      if (!dragging && moved) { dragging = true; el.classList.add('dragging'); }
      if (!dragging) return;
      const over = document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest('.pg')).find((n) => n && n !== el);
      const target = over && tiles.find((t) => t.el === over);
      if (!target) return;
      const r = target.el.getBoundingClientRect();
      tiles.splice(tiles.indexOf(tile), 1);
      tiles.splice(tiles.indexOf(target) + (e.clientX > r.left + r.width / 2 ? 1 : 0), 0, tile);
      refresh();
    };
    const noScroll = (e: TouchEvent) => { if (armed) e.preventDefault(); };
    const finish = (click: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      el.removeEventListener('touchmove', noScroll);
      el.classList.remove('dragging', 'armed');
      if (dragging) result.replaceChildren();
      else if (click) { tile.selected = !tile.selected; refresh(); }
    };
    const up = (e: PointerEvent) => { if (e.pointerId === down.pointerId) finish(true); };
    const cancel = (e: PointerEvent) => { if (e.pointerId === down.pointerId) finish(false); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    el.addEventListener('touchmove', noScroll, { passive: false });
  });
  el.addEventListener('contextmenu', (e) => { if (el.classList.contains('armed')) e.preventDefault(); });
  el.addEventListener('keydown', (e) => {
    const i = tiles.indexOf(tile);
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tile.selected = !tile.selected; refresh(); }
    else if ((e.altKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const j = i + (e.key === 'ArrowLeft' ? -1 : 1);
      if (j < 0 || j >= tiles.length) return;
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
      refresh();
      el.focus();
    }
  });
}

// ---------- Output ----------

const opts = () => ({
  clean: $<HTMLInputElement>('clean').checked,
  pageSize: $<HTMLSelectElement>('page-size').value as PageSize,
});
const baseName = () => (sources.length === 1 ? sources[0].name : 'merged.pdf');
const pad = (n: number, of: number) => String(n).padStart(String(of).length, '0');

async function busy(label: string, work: () => Promise<void>) {
  buttons.forEach((b) => (b.disabled = true));
  result.replaceChildren();
  setStatus(label, 0, tiles[0]?.el.querySelector('canvas') ?? undefined);
  try {
    await work();
    status.hidden = true;
  } catch (e) {
    fail(e);
  } finally {
    refresh();
  }
}

function report(found: string[], what: string) {
  const ok = !opts().clean || found.length === 0;
  result.innerHTML = `<div class="notice ${ok ? '' : 'danger'}">${what}
    ${opts().clean ? (ok ? ' ✓ Verified: a re-scan of the new file finds no metadata.' : ` ⚠ Still found: ${found.map(escapeHtml).join('; ')}`) : ' Metadata kept, as you chose.'}</div>`;
}

$('save').addEventListener('click', () => busy('Building your PDF…', async () => {
  const pages = targets();
  const out = await build(pages, opts());
  download(new Blob([out as BlobPart], { type: 'application/pdf' }), withSuffix(baseName(), selected().length ? 'pages' : 'edited', 'pdf'));
  report(await verify(out), `${pages.length} page${pages.length === 1 ? '' : 's'} · ${formatBytes(out.length)}.`);
}));

$('split').addEventListener('click', () => busy('Splitting…', async () => {
  const pages = targets();
  const files: { name: string; data: Uint8Array }[] = [];
  const leftovers = new Set<string>();
  for (const [i, p] of pages.entries()) {
    setStatus(`Splitting: page ${i + 1} of ${pages.length}`, i / pages.length);
    const data = await build([p], opts());
    (await verify(data)).forEach((f) => leftovers.add(f));
    files.push({ name: withSuffix(baseName(), `p${pad(i + 1, pages.length)}`, 'pdf'), data });
  }
  if (files.length === 1) download(new Blob([files[0].data as BlobPart], { type: 'application/pdf' }), files[0].name);
  else download(zip(files), withSuffix(baseName(), 'pages', 'zip'));
  report([...leftovers], `${files.length} file${files.length === 1 ? '' : 's'}${files.length > 1 ? ' in a .zip' : ''}.`);
}));

$('images').addEventListener('click', () => busy('Exporting images…', async () => {
  const pages = targets();
  const type = $<HTMLSelectElement>('image-type').value as 'png' | 'jpeg';
  const files: { name: string; data: Uint8Array }[] = [];
  for (const [i, p] of pages.entries()) {
    setStatus(`Exporting: page ${i + 1} of ${pages.length}`, i / pages.length);
    // 150 dpi: sharp on screen and fine for printing at normal size.
    const canvas = await renderPage(p, { scale: 150 / 72 });
    const blob = await canvasToBlob(canvas, `image/${type}`, 0.9);
    files.push({ name: withSuffix(baseName(), `p${pad(i + 1, pages.length)}`, type === 'jpeg' ? 'jpg' : 'png'), data: new Uint8Array(await blob.arrayBuffer()) });
  }
  if (files.length === 1) download(new Blob([files[0].data as BlobPart]), files[0].name);
  else download(zip(files), withSuffix(baseName(), 'images', 'zip'));
  result.innerHTML = `<div class="notice">${files.length} image${files.length === 1 ? '' : 's'} at 150 dpi${files.length > 1 ? ', in a .zip' : ''}. Images are drawn fresh, so they carry no metadata.</div>`;
}));
