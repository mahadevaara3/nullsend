import { mountShell } from '../../core/shell';
import { dropZone, download, escapeHtml, withSuffix } from '../../core/files';
import { formatBytes } from '../../core/meter';
import { parseContainer, stripMetadata, type Container, type SegmentKind } from './container';
import { analyze, type Report } from './findings';
import './xray.css';

mountShell('metadata');

const results = document.getElementById('results')!;
const batch = document.getElementById('batch')!;
const keepColor = document.getElementById('keep-color') as HTMLInputElement;
const keepOrient = document.getElementById('keep-orient') as HTMLInputElement;

interface Item { file: File; container: Container; report: Report; card: HTMLElement }
const items: Item[] = [];

const KIND_LABEL: Record<SegmentKind, string> = {
  image: 'Pixel data', structure: 'File structure', color: 'Color profile', metadata: 'Metadata', trailer: 'Hidden extra data',
};

dropZone(document.getElementById('drop')!, {
  accept: 'image/jpeg,image/png,image/webp',
  multiple: true,
  onFiles: (files) => {
    document.getElementById('drop')!.classList.add('compact');
    files.forEach(addFile);
  },
});

async function addFile(file: File) {
  const card = document.createElement('article');
  card.className = 'card xray';
  card.innerHTML = `<p class="muted">Reading ${escapeHtml(file.name)}…</p>`;
  results.prepend(card);
  try {
    const container = parseContainer(new Uint8Array(await file.arrayBuffer()));
    const report = await analyze(file, container);
    const item = { file, container, report, card };
    items.push(item);
    render(item);
    batch.hidden = false;
  } catch (e) {
    card.innerHTML = `<div class="notice danger"><b>${escapeHtml(file.name)}</b>: ${escapeHtml((e as Error).message)}</div>`;
  }
}

function sizeBy(c: Container) {
  const totals: Record<SegmentKind, number> = { image: 0, structure: 0, color: 0, metadata: 0, trailer: 0 };
  for (const s of c.segments) totals[s.kind] += s.length;
  return totals;
}

function byteMap(c: Container): string {
  const total = c.bytes.length;
  const blocks = c.segments.map((s) =>
    `<span class="k-${s.kind}" style="flex-grow:${s.length}" title="${escapeHtml(s.label)} · ${formatBytes(s.length)}"></span>`).join('');
  const totals = sizeBy(c);
  const legend = (Object.keys(totals) as SegmentKind[]).filter((k) => totals[k] > 0).map((k) =>
    `<span><i class="k-${k}"></i>${KIND_LABEL[k]} ${formatBytes(totals[k])} (${((totals[k] / total) * 100).toFixed(totals[k] / total < 0.01 ? 2 : 0)}%)</span>`).join('');
  return `<div class="bytemap" role="img" aria-label="Map of the file's bytes by type">${blocks}</div><div class="legend">${legend}</div>`;
}

function gpsMap(lat: number, lon: number): string {
  // An offline world grid. Fetching map tiles would tell a map server where the photo was taken.
  const x = ((lon + 180) / 360) * 360;
  const y = ((90 - lat) / 180) * 180;
  const lines = [...Array(11).keys()].map((i) => `<line x1="${i * 36}" y1="0" x2="${i * 36}" y2="180"/>`).join('')
    + [...Array(7).keys()].map((i) => `<line x1="0" y1="${i * 30}" x2="360" y2="${i * 30}"/>`).join('');
  const osm = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=15/${lat.toFixed(5)}/${lon.toFixed(5)}`;
  return `<div class="gps">
    <svg viewBox="0 0 360 180" aria-hidden="true"><g class="grid">${lines}</g><line class="eq" x1="0" y1="90" x2="360" y2="90"/>
      <circle class="ping" cx="${x}" cy="${y}" r="10"/><circle class="dot" cx="${x}" cy="${y}" r="4"/></svg>
    <div><b class="mono">${lat.toFixed(5)}, ${lon.toFixed(5)}</b>
      <p class="muted">Anyone you send this photo to can see this spot.</p>
      <a href="${osm}" target="_blank" rel="noreferrer noopener">View on OpenStreetMap ↗</a>
      <p class="muted small">Opening the map shares these coordinates with openstreetmap.org. Nothing is sent unless you click.</p></div>
  </div>`;
}

function render(item: Item) {
  const { file, container: c, report: r, card } = item;
  const meta = c.segments.filter((s) => s.kind === 'metadata' || s.kind === 'trailer');
  const high = r.findings.filter((f) => f.severity === 'high').length;
  const ai = r.findings.filter((f) => f.severity === 'ai').length;
  const thumb = URL.createObjectURL(file);
  const status = meta.length === 0 ? '<span class="pill ok">Clean</span>'
    : `${high ? `<span class="pill danger">${high} sensitive</span>` : ''}${ai ? `<span class="pill warn">AI / provenance</span>` : ''}<span class="pill">${meta.length} metadata block${meta.length === 1 ? '' : 's'}</span>`;

  card.innerHTML = `
    <header class="xray-head">
      <img src="${thumb}" alt="" />
      <div><h3>${escapeHtml(file.name)}</h3>
        <div class="row"><span class="muted mono">${c.format.toUpperCase()} · ${formatBytes(file.size)}</span>${status}</div></div>
      <button class="btn primary clean" ${meta.length === 0 ? 'disabled' : ''}>Remove metadata</button>
    </header>
    ${byteMap(c)}
    ${r.gps ? gpsMap(r.gps.lat, r.gps.lon) : ''}
    ${r.findings.length ? `<ul class="findings">${r.findings.map((f) => `
      <li class="sev-${f.severity}"><b>${escapeHtml(f.title)}</b><span>${escapeHtml(f.detail)}</span></li>`).join('')}</ul>`
      : '<p class="muted">No identifying metadata found.</p>'}
    <div class="result"></div>
    <details><summary>All ${c.segments.length} segments</summary>
      <div class="seg-table"><table><thead><tr><th>Offset</th><th>Size</th><th>ID</th><th>What it is</th></tr></thead><tbody>
      ${c.segments.map((s) => `<tr class="k-row-${s.kind}"><td class="mono">${s.offset}</td><td class="mono">${formatBytes(s.length)}</td>
        <td class="mono">${escapeHtml(s.id)}</td><td>${escapeHtml(s.label)}</td></tr>`).join('')}
      </tbody></table></div></details>`;
  card.querySelector<HTMLButtonElement>('.clean')!.addEventListener('click', () => clean(item));
}

function clean(item: Item) {
  const { file, container: c, report: r, card } = item;
  const out = stripMetadata(c, {
    keepColorProfile: keepColor.checked,
    orientation: keepOrient.checked ? r.orientation : undefined,
  });
  // Re-parse our own output to prove the result rather than assume it.
  const check = parseContainer(out);
  const left = check.segments.filter((s) => s.kind === 'metadata' || s.kind === 'trailer');
  const onlyOrientation = left.length === 1 && left[0].id === 'APP1:Exif' && left[0].length === 36;
  const ok = left.length === 0 || onlyOrientation;
  const pixelsSame = sameImageData(c, check);
  card.querySelector('.result')!.innerHTML = `<div class="notice ${ok && pixelsSame ? '' : 'danger'}">
    ${ok ? '✓ Verified: a re-scan of the new file finds no metadata' : '⚠ Some metadata could not be removed'}${onlyOrientation ? ' (except the rotation flag you chose to keep)' : ''}.
    ${formatBytes(c.bytes.length - out.length)} removed. ${pixelsSame ? 'Pixel data is byte-for-byte identical, with no re-compression.' : 'Pixel data changed unexpectedly.'}</div>`;
  download(new Blob([out as BlobPart], { type: file.type }), withSuffix(file.name, 'clean'));
}

function sameImageData(a: Container, b: Container): boolean {
  const img = (c: Container) => c.segments.filter((s) => s.kind === 'image').map((s) => c.bytes.subarray(s.offset, s.offset + s.length));
  const x = img(a), y = img(b);
  return x.length === y.length && x.every((p, i) => p.length === y[i].length && p.every((v, j) => v === y[i][j]));
}

document.getElementById('clean-all')!.addEventListener('click', async () => {
  for (const item of items) {
    if (item.card.querySelector<HTMLButtonElement>('.clean')?.disabled) continue;
    clean(item);
    await new Promise((r) => setTimeout(r, 250)); // browsers throttle rapid back-to-back downloads
  }
});
