import { mountShell } from '../../core/shell';
import { NO_FILE, SHOW_VALUES, category, registerTools } from '../../core/webmcp';
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
$('delete').addEventListener('click', () => removeTiles(selected()));
function removeTiles(gone: Tile[]) {
  tiles = tiles.filter((t) => !gone.includes(t));
  for (const s of sources.filter((s) => !tiles.some((t) => t.src === s))) {
    sources.splice(sources.indexOf(s), 1);
    closeSource(s);
  }
  result.replaceChildren();
  if (!tiles.length) { board.hidden = true; drop.classList.remove('compact'); }
  refresh();
}

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

async function busy(label: string, work: () => Promise<string>): Promise<string> {
  buttons.forEach((b) => (b.disabled = true));
  result.replaceChildren();
  setStatus(label, 0, tiles[0]?.el.querySelector('canvas') ?? undefined);
  try {
    const summary = await work();
    status.hidden = true;
    return summary;
  } catch (e) {
    fail(e);
    throw e;
  } finally {
    refresh();
  }
}

function report(found: string[], what: string): string {
  const ok = !opts().clean || found.length === 0;
  result.innerHTML = `<div class="notice ${ok ? '' : 'danger'}">${what}
    ${opts().clean ? (ok ? ' ✓ Verified: a re-scan of the new file finds no metadata.' : ` ⚠ Still found: ${found.map(escapeHtml).join('; ')}`) : ' Metadata kept, as you chose.'}</div>`;
  return result.textContent!.replace(/\s+/g, ' ').trim();
}

const savePdf = (pages: Tile[]) => busy('Building your PDF…', async () => {
  const out = await build(pages, opts());
  download(new Blob([out as BlobPart], { type: 'application/pdf' }), withSuffix(baseName(), pages.length < tiles.length ? 'pages' : 'edited', 'pdf'));
  return report(await verify(out), `${pages.length} page${pages.length === 1 ? '' : 's'} · ${formatBytes(out.length)}.`);
});

const splitPdf = (pages: Tile[]) => busy('Splitting…', async () => {
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
  return report([...leftovers], `${files.length} file${files.length === 1 ? '' : 's'}${files.length > 1 ? ' in a .zip' : ''}.`);
});

const exportImages = (pages: Tile[], type: 'png' | 'jpeg') => busy('Exporting images…', async () => {
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
  return result.textContent!.trim();
});

const quiet = (p: Promise<unknown>) => void p.catch(() => {}); // errors are already shown in the status card
$('save').addEventListener('click', () => quiet(savePdf(targets())));
$('split').addEventListener('click', () => quiet(splitPdf(targets())));
$('images').addEventListener('click', () => quiet(exportImages(targets(), $<HTMLSelectElement>('image-type').value as 'png' | 'jpeg')));

// ---------- WebMCP ----------

/** Page numbers are 1-based positions in the current order, as list_pages shows them. */
function at(numbers: number[] | undefined): Tile[] {
  if (!tiles.length) throw new Error(NO_FILE);
  if (!numbers?.length) return [...tiles];
  const bad = numbers.filter((n) => !Number.isInteger(n) || n < 1 || n > tiles.length);
  if (bad.length) throw new Error(`No page ${bad.join(', ')}. There are ${tiles.length} pages.`);
  return [...new Set(numbers)].map((n) => tiles[n - 1]);
}
const PAGES = { pages: { type: 'array', items: { type: 'integer' }, description: 'Page numbers (1-based, in the current order). Omit for all pages.' } };
const CLEAN = { remove_metadata: { type: 'boolean', description: 'Remove author, dates, XMP, comment authors and photo EXIF. Default true.' } };
const setClean = (v?: boolean) => { $<HTMLInputElement>('clean').checked = v ?? true; };

registerTools([
  {
    name: 'list_pages',
    title: 'List PDF pages',
    description: 'Lists every page on the board in its current order: page number, the file it came from, its page number in that file, and any extra rotation. Also lists the hidden metadata each loaded file carries.',
    inputSchema: { type: 'object', properties: { ...SHOW_VALUES } },
    readOnly: true,
    execute: ({ show_values }) => {
      if (!tiles.length) return NO_FILE;
      return {
        pages: tiles.map((t, i) => ({ page: i + 1, file: t.src.name, source_page: t.index + 1, extra_rotation: t.rotate })),
        files: sources.map((s) => ({ file: s.name, kind: s.kind, pages: s.pageCount, metadata: s.found.map((f) => category(f, !!show_values)) })),
      };
    },
  },
  {
    name: 'reorder_pages',
    title: 'Reorder PDF pages',
    description: 'Puts pages in a new order. Pass the current page numbers in the order they should appear; pages left out keep their relative order after the listed ones.',
    inputSchema: { type: 'object', properties: { order: { type: 'array', items: { type: 'integer' }, description: 'Current page numbers in the new order.' } }, required: ['order'] },
    execute: ({ order }) => {
      const first = at(order);
      tiles = [...first, ...tiles.filter((t) => !first.includes(t))];
      result.replaceChildren();
      refresh();
      return `New order: ${tiles.map((t) => `${t.src.name} p${t.index + 1}`).join(', ')}`;
    },
  },
  {
    name: 'rotate_pages',
    title: 'Rotate PDF pages',
    description: 'Rotates pages clockwise.',
    inputSchema: { type: 'object', properties: { ...PAGES, degrees: { type: 'integer', enum: [90, 180, 270] } }, required: ['degrees'] },
    execute: ({ pages, degrees }) => {
      const sel = at(pages);
      sel.forEach((t) => (t.rotate = (t.rotate + degrees) % 360));
      renderThumbs(sel);
      result.replaceChildren();
      return `Rotated ${sel.length} page${sel.length === 1 ? '' : 's'} by ${degrees}°.`;
    },
  },
  {
    name: 'delete_pages',
    title: 'Delete PDF pages',
    description: 'Removes pages from the board. The user\'s original files are not changed.',
    inputSchema: { type: 'object', properties: { pages: PAGES.pages }, required: ['pages'] },
    execute: ({ pages }) => {
      const gone = at(pages);
      removeTiles(gone);
      return `Deleted ${gone.length} page${gone.length === 1 ? '' : 's'}. ${tiles.length} left.`;
    },
  },
  {
    name: 'download_pdf',
    title: 'Download as PDF',
    description: 'Builds one PDF from the given pages (or all pages, which merges every loaded file), verifies the metadata removal, and downloads it to the user\'s device.',
    inputSchema: {
      type: 'object',
      properties: { ...PAGES, ...CLEAN, photo_page_size: { type: 'string', enum: ['a4', 'letter', 'image'], description: 'Page size for photos. Default a4.' } },
    },
    consequential: true,
    execute: ({ pages, remove_metadata, photo_page_size }) => {
      setClean(remove_metadata);
      if (photo_page_size) $<HTMLSelectElement>('page-size').value = photo_page_size;
      return savePdf(at(pages));
    },
  },
  {
    name: 'split_pdf',
    title: 'Split into single pages',
    description: 'Saves each of the given pages (or all) as its own PDF, zipped, and downloads it to the user\'s device.',
    inputSchema: { type: 'object', properties: { ...PAGES, ...CLEAN } },
    consequential: true,
    execute: ({ pages, remove_metadata }) => { setClean(remove_metadata); return splitPdf(at(pages)); },
  },
  {
    name: 'export_images',
    title: 'Export pages as images',
    description: 'Renders the given pages (or all) as 150 dpi images and downloads them to the user\'s device, zipped when there is more than one.',
    inputSchema: { type: 'object', properties: { ...PAGES, format: { type: 'string', enum: ['png', 'jpeg'], description: 'Default png.' } } },
    consequential: true,
    execute: ({ pages, format = 'png' }) => exportImages(at(pages), format),
  },
]);
