// HEIC/HEIF is an ISO BMFF file: a `meta` box indexes "items" (image tiles,
// thumbnails, EXIF, XMP) whose bytes usually live in `mdat`. Metadata is
// removed by dropping those items from the index and cutting their bytes out of
// `mdat`, then shifting every remaining file offset. Image data is never decoded.
import type { Segment, SegmentKind } from './container';

interface Box { type: string; start: number; header: number; end: number }

interface IlocItem {
  id: number;
  method: number;
  dataRef: number;
  base: number;
  extents: { index: number; offset: number; length: number }[];
}

interface Iloc {
  version: number;
  flags: number;
  offsetSize: number;
  lengthSize: number;
  baseSize: number;
  indexSize: number;
  items: IlocItem[];
}

export interface HeifLayout {
  top: Box[];
  meta: Box;
  children: Box[];
  iloc: Iloc;
  /** Item IDs that hold metadata (EXIF, XMP). */
  metaItems: Set<number>;
}

const latin1 = new TextDecoder('latin1');

function boxes(b: Uint8Array, dv: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  let i = from;
  while (i + 8 <= to) {
    let size = dv.getUint32(i);
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(i + 8)); header = 16; }
    else if (size === 0) size = to - i;
    if (size < header || i + size > to) throw new Error(`Corrupt HEIC: bad box size at byte ${i}`);
    out.push({ type: latin1.decode(b.subarray(i + 4, i + 8)), start: i, header, end: i + size });
    i += size;
  }
  return out;
}

const readN = (dv: DataView, at: number, n: number) =>
  n === 0 ? 0 : n === 2 ? dv.getUint16(at) : n === 4 ? dv.getUint32(at) : n === 8 ? Number(dv.getBigUint64(at)) : NaN;

function writeN(dv: DataView, at: number, n: number, v: number) {
  if (n === 2) dv.setUint16(at, v);
  else if (n === 4) dv.setUint32(at, v);
  else if (n === 8) dv.setBigUint64(at, BigInt(v));
}

function parseIloc(dv: DataView, box: Box): Iloc {
  let p = box.start + box.header;
  const version = dv.getUint8(p);
  const flags = dv.getUint32(p) & 0xffffff;
  p += 4;
  const offsetSize = dv.getUint8(p) >> 4, lengthSize = dv.getUint8(p) & 15;
  const baseSize = dv.getUint8(p + 1) >> 4, indexSize = version > 0 ? dv.getUint8(p + 1) & 15 : 0;
  p += 2;
  const count = version < 2 ? dv.getUint16(p) : dv.getUint32(p);
  p += version < 2 ? 2 : 4;
  const items: IlocItem[] = [];
  for (let n = 0; n < count; n++) {
    const id = version < 2 ? dv.getUint16(p) : dv.getUint32(p);
    p += version < 2 ? 2 : 4;
    let method = 0;
    if (version > 0) { method = dv.getUint16(p) & 15; p += 2; }
    const dataRef = dv.getUint16(p); p += 2;
    const base = readN(dv, p, baseSize); p += baseSize;
    const extentCount = dv.getUint16(p); p += 2;
    const extents = [];
    for (let e = 0; e < extentCount; e++) {
      const index = readN(dv, p, indexSize); p += indexSize;
      const offset = readN(dv, p, offsetSize); p += offsetSize;
      const length = readN(dv, p, lengthSize); p += lengthSize;
      extents.push({ index, offset, length });
    }
    items.push({ id, method, dataRef, base, extents });
  }
  return { version, flags, offsetSize, lengthSize, baseSize, indexSize, items };
}

function writeIloc(l: Iloc, items: IlocItem[]): Uint8Array {
  const idSize = l.version < 2 ? 2 : 4;
  const perItem = idSize + (l.version > 0 ? 2 : 0) + 2 + l.baseSize + 2;
  const perExtent = l.indexSize + l.offsetSize + l.lengthSize;
  const size = 8 + 4 + 2 + idSize + items.reduce((n, it) => n + perItem + it.extents.length * perExtent, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  out.set([0x69, 0x6c, 0x6f, 0x63], 4); // "iloc"
  dv.setUint32(8, (l.version << 24) | l.flags);
  dv.setUint8(12, (l.offsetSize << 4) | l.lengthSize);
  dv.setUint8(13, (l.baseSize << 4) | l.indexSize);
  let p = 14;
  writeN(dv, p, idSize, items.length); p += idSize;
  for (const it of items) {
    writeN(dv, p, idSize, it.id); p += idSize;
    if (l.version > 0) { dv.setUint16(p, it.method); p += 2; }
    dv.setUint16(p, it.dataRef); p += 2;
    writeN(dv, p, l.baseSize, it.base); p += l.baseSize;
    dv.setUint16(p, it.extents.length); p += 2;
    for (const e of it.extents) {
      writeN(dv, p, l.indexSize, e.index); p += l.indexSize;
      writeN(dv, p, l.offsetSize, e.offset); p += l.offsetSize;
      writeN(dv, p, l.lengthSize, e.length); p += l.lengthSize;
    }
  }
  return out;
}

/** Item ID → [type, MIME content type] from the `iinf` box. */
function parseIinf(b: Uint8Array, dv: DataView, box: Box): Map<number, { type: string; mime: string; box: Box }> {
  const p = box.start + box.header;
  const version = dv.getUint8(p);
  const out = new Map<number, { type: string; mime: string; box: Box }>();
  for (const infe of boxes(b, dv, p + (version === 0 ? 6 : 8), box.end)) {
    let q = infe.start + infe.header;
    const v = dv.getUint8(q);
    if (infe.type !== 'infe' || v < 2) continue;
    q += 4;
    const id = v === 2 ? dv.getUint16(q) : dv.getUint32(q);
    q += (v === 2 ? 2 : 4) + 2; // item ID, protection index
    const type = latin1.decode(b.subarray(q, q + 4));
    q += 4;
    q = b.indexOf(0, q) + 1; // item name
    const mime = type === 'mime' ? latin1.decode(b.subarray(q, Math.max(q, b.indexOf(0, q)))) : '';
    out.set(id, { type, mime, box: infe });
  }
  return out;
}

const isMetaItem = (t: { type: string; mime: string }) =>
  t.type === 'Exif' || (t.type === 'mime' && /xmp|rdf\+xml/i.test(t.mime));

export function parseHeif(b: Uint8Array): { segments: Segment[]; layout: HeifLayout } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const top = boxes(b, dv, 0, b.length);
  const meta = top.find((x) => x.type === 'meta');
  if (!meta) throw new Error('Corrupt HEIC: no meta box');
  const children = boxes(b, dv, meta.start + meta.header + 4, meta.end);
  const ilocBox = children.find((x) => x.type === 'iloc');
  const iinfBox = children.find((x) => x.type === 'iinf');
  if (!ilocBox || !iinfBox) throw new Error('Corrupt HEIC: missing item index');
  const iloc = parseIloc(dv, ilocBox);
  const info = parseIinf(b, dv, iinfBox);
  const metaItems = new Set([...info].filter(([, t]) => isMetaItem(t)).map(([id]) => id));

  // Metadata byte ranges inside mdat, labelled for the byte map.
  const ranges: { offset: number; length: number; id: string; label: string }[] = [];
  for (const it of iloc.items) {
    const t = info.get(it.id);
    if (!t || !metaItems.has(it.id) || it.method !== 0) continue;
    for (const e of it.extents) {
      ranges.push({
        offset: it.base + e.offset, length: e.length || b.length - (it.base + e.offset),
        id: t.type === 'Exif' ? 'Exif' : 'XMP', label: t.type === 'Exif' ? 'EXIF (camera, GPS, dates)' : 'XMP metadata',
      });
    }
  }
  ranges.sort((x, y) => x.offset - y.offset);

  const segments: Segment[] = [];
  const push = (offset: number, length: number, kind: SegmentKind, id: string, label: string) =>
    length > 0 && segments.push({ offset, length, kind, id, label, payload: b.subarray(offset, offset + length) });
  for (const box of top) {
    if (box.type === 'mdat') {
      push(box.start, box.header, 'structure', 'mdat', 'Media data header');
      let i = box.start + box.header;
      for (const r of ranges.filter((r) => r.offset >= i && r.offset < box.end)) {
        push(i, r.offset - i, 'image', 'mdat', 'Compressed image data');
        push(r.offset, r.length, 'metadata', r.id, r.label);
        i = r.offset + r.length;
      }
      push(i, box.end - i, 'image', 'mdat', 'Compressed image data');
    } else if (box.type === 'ftyp') push(box.start, box.end - box.start, 'structure', 'ftyp', 'File type');
    else if (box.type === 'meta') push(box.start, box.end - box.start, 'structure', 'meta', 'Image index and properties (incl. color profile)');
    else if (box.type === 'uuid') push(box.start, box.end - box.start, 'metadata', 'uuid', 'Vendor box (often C2PA Content Credentials)');
    else push(box.start, box.end - box.start, 'structure', box.type, `${box.type} box`);
  }
  return { segments, layout: { top, meta, children, iloc, metaItems } };
}

/** Rebuilds an ISOBMFF reference box (`iref`) or property map (`ipma`) without the removed items. */
function filterIref(b: Uint8Array, dv: DataView, box: Box, drop: Set<number>): Uint8Array {
  const p = box.start + box.header;
  const wide = dv.getUint8(p) === 1;
  const id = (at: number) => (wide ? dv.getUint32(at) : dv.getUint16(at));
  const w = wide ? 4 : 2;
  const parts: Uint8Array[] = [b.slice(box.start, p + 4)];
  for (const ref of boxes(b, dv, p + 4, box.end)) {
    let q = ref.start + ref.header;
    const from = id(q);
    const n = dv.getUint16(q + w);
    q += w + 2;
    const to = [...Array(n).keys()].map((k) => id(q + k * w)).filter((x) => !drop.has(x));
    if (drop.has(from) || to.length === 0) continue;
    const out = new Uint8Array(8 + w + 2 + to.length * w);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, out.length);
    out.set(b.subarray(ref.start + 4, ref.start + 8), 4);
    writeN(odv, 8, w, from);
    odv.setUint16(8 + w, to.length);
    to.forEach((x, k) => writeN(odv, 10 + w + k * w, w, x));
    parts.push(out);
  }
  return withSize(parts);
}

function filterIpma(b: Uint8Array, dv: DataView, box: Box, drop: Set<number>): Uint8Array {
  let p = box.start + box.header;
  const version = dv.getUint8(p), flags = dv.getUint32(p) & 0xffffff;
  const idSize = version < 1 ? 2 : 4, assocSize = flags & 1 ? 2 : 1;
  const count = dv.getUint32(p + 4);
  p += 8;
  const kept: Uint8Array[] = [];
  for (let n = 0; n < count; n++) {
    const id = readN(dv, p, idSize);
    const len = idSize + 1 + dv.getUint8(p + idSize) * assocSize;
    if (!drop.has(id)) kept.push(b.subarray(p, p + len));
    p += len;
  }
  const head = b.slice(box.start, box.start + box.header + 8);
  new DataView(head.buffer).setUint32(box.header + 4, kept.length);
  return withSize([head, ...kept]);
}

function filterIinf(b: Uint8Array, dv: DataView, box: Box, drop: Set<number>, info: Map<number, { box: Box }>): Uint8Array {
  const p = box.start + box.header;
  const version = dv.getUint8(p);
  const dropped = new Set([...drop].map((id) => info.get(id)?.box.start));
  const entries = boxes(b, dv, p + (version === 0 ? 6 : 8), box.end).filter((x) => !dropped.has(x.start));
  const head = b.slice(box.start, p + (version === 0 ? 6 : 8));
  const hdv = new DataView(head.buffer);
  if (version === 0) hdv.setUint16(box.header + 4, entries.length);
  else hdv.setUint32(box.header + 4, entries.length);
  return withSize([head, ...entries.map((x) => b.subarray(x.start, x.end))]);
}

/** Concatenates parts and writes the total into the first 32-bit size field. */
function withSize(parts: Uint8Array[]): Uint8Array {
  const out = concat(parts);
  new DataView(out.buffer).setUint32(0, out.length);
  return out;
}

export function stripHeif(b: Uint8Array, l: HeifLayout): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const drop = l.metaItems;
  const info = parseIinf(b, dv, l.children.find((x) => x.type === 'iinf')!);

  // Byte ranges to cut from mdat.
  const cuts: [number, number][] = [];
  for (const it of l.iloc.items) {
    if (!drop.has(it.id) || it.method !== 0) continue;
    for (const e of it.extents) cuts.push([it.base + e.offset, it.base + e.offset + e.length]);
  }
  cuts.sort((x, y) => x[0] - y[0]);
  const cutBefore = (o: number) => cuts.reduce((n, [s, e]) => n + (e <= o ? e - s : 0), 0);

  // Rebuild meta. iloc's size doesn't depend on offset values, so lay it out first and patch later.
  const keptItems = l.iloc.items.filter((it) => !drop.has(it.id));
  const metaParts: Uint8Array[] = [b.slice(l.meta.start, l.meta.start + l.meta.header + 4)];
  let ilocIndex = -1;
  for (const c of l.children) {
    if (c.type === 'iloc') { ilocIndex = metaParts.length; metaParts.push(writeIloc(l.iloc, keptItems)); }
    else if (c.type === 'iinf') metaParts.push(filterIinf(b, dv, c, drop, info));
    else if (c.type === 'iref') metaParts.push(filterIref(b, dv, c, drop));
    else if (c.type === 'iprp') {
      const kids = boxes(b, dv, c.start + c.header, c.end);
      metaParts.push(withSize([b.slice(c.start, c.start + c.header),
        ...kids.map((k) => (k.type === 'ipma' ? filterIpma(b, dv, k, drop) : b.subarray(k.start, k.end)))]));
    } else metaParts.push(b.subarray(c.start, c.end));
  }
  const metaLen = metaParts.reduce((n, p) => n + p.length, 0);

  // New position of every kept top-level box, so old file offsets can be mapped to new ones.
  const keptTop = l.top.filter((x) => x.type !== 'uuid');
  const moved: { box: Box; at: number }[] = [];
  let at = 0;
  for (const box of keptTop) {
    moved.push({ box, at });
    const cut = box.type === 'mdat' ? cutBefore(box.end) - cutBefore(box.start) : 0;
    at += box === l.meta ? metaLen : box.end - box.start - cut;
  }
  const map = (o: number) => {
    const m = moved.find(({ box }) => o >= box.start && o < box.end) ?? moved[moved.length - 1];
    return m.at + (o - m.box.start) - (m.box.type === 'mdat' ? cutBefore(o) - cutBefore(m.box.start) : 0);
  };

  for (const it of keptItems) {
    if (it.method !== 0 || it.dataRef !== 0) continue;
    const newBase = it.base ? map(it.base) : 0;
    it.extents = it.extents.map((e) => ({ ...e, offset: map(it.base + e.offset) - newBase }));
    it.base = newBase;
  }
  metaParts[ilocIndex] = writeIloc(l.iloc, keptItems);
  const meta = withSize(metaParts);

  const out: Uint8Array[] = [];
  for (const box of keptTop) {
    if (box === l.meta) { out.push(meta); continue; }
    if (box.type !== 'mdat') { out.push(b.subarray(box.start, box.end)); continue; }
    const pieces: Uint8Array[] = [];
    let i = box.start + box.header;
    for (const [s, e] of cuts.filter(([s]) => s >= i && s < box.end)) {
      pieces.push(b.subarray(i, s));
      i = Math.max(i, e);
    }
    pieces.push(b.subarray(i, box.end));
    const head = b.slice(box.start, box.start + box.header);
    const size = box.header + pieces.reduce((n, p) => n + p.length, 0);
    const hdv = new DataView(head.buffer);
    if (box.header === 16) hdv.setBigUint64(8, BigInt(size));
    else if (hdv.getUint32(0) !== 0) hdv.setUint32(0, size);
    out.push(head, ...pieces);
  }
  return concat(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
