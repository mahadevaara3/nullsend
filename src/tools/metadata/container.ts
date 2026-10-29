// Walks the container structure of JPEG, PNG and WebP files and labels every
// segment/chunk. This is what lets us strip metadata *without re-encoding*:
// pixel data is copied byte for byte, so quality is untouched.

export type SegmentKind = 'image' | 'structure' | 'color' | 'metadata' | 'trailer';
export type Format = 'jpeg' | 'png' | 'webp';

export interface Segment {
  offset: number;
  length: number;
  kind: SegmentKind;
  /** Short machine id, e.g. "APP1:Exif", "tEXt", "EXIF". */
  id: string;
  /** Human-readable description. */
  label: string;
  /** Payload bytes (without marker/length/CRC framing). */
  payload: Uint8Array;
}

export interface Container {
  format: Format;
  bytes: Uint8Array;
  segments: Segment[];
}

const latin1 = new TextDecoder('latin1');
const startsWith = (b: Uint8Array, s: string) => latin1.decode(b.subarray(0, s.length)) === s;

export function detectFormat(b: Uint8Array): Format | null {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (startsWith(b, '\x89PNG\r\n\x1a\n')) return 'png';
  if (startsWith(b, 'RIFF') && latin1.decode(b.subarray(8, 12)) === 'WEBP') return 'webp';
  return null;
}

export function parseContainer(bytes: Uint8Array): Container {
  const format = detectFormat(bytes);
  if (format === 'jpeg') return { format, bytes, segments: parseJpeg(bytes) };
  if (format === 'png') return { format, bytes, segments: parsePng(bytes) };
  if (format === 'webp') return { format, bytes, segments: parseWebp(bytes) };
  throw new Error('Unsupported file. Use a JPEG, PNG or WebP image.');
}

// ---------- JPEG ----------

function classifyJpegApp(n: number, p: Uint8Array): Pick<Segment, 'kind' | 'id' | 'label'> {
  const app = `APP${n}`;
  if (n === 0 && startsWith(p, 'JFIF\0')) return { kind: 'structure', id: 'APP0:JFIF', label: 'JFIF header' };
  if (n === 0 && startsWith(p, 'JFXX\0')) return { kind: 'metadata', id: 'APP0:JFXX', label: 'JFIF thumbnail' };
  if (n === 1 && startsWith(p, 'Exif\0')) return { kind: 'metadata', id: 'APP1:Exif', label: 'EXIF (camera, GPS, dates, thumbnail)' };
  if (n === 1 && startsWith(p, 'http://ns.adobe.com/xap/1.0/\0')) return { kind: 'metadata', id: 'APP1:XMP', label: 'XMP metadata' };
  if (n === 1 && startsWith(p, 'http://ns.adobe.com/xmp/extension/\0')) return { kind: 'metadata', id: 'APP1:XMP-ext', label: 'Extended XMP' };
  if (n === 2 && startsWith(p, 'ICC_PROFILE\0')) return { kind: 'color', id: 'APP2:ICC', label: 'ICC color profile' };
  if (n === 2 && startsWith(p, 'MPF\0')) return { kind: 'metadata', id: 'APP2:MPF', label: 'Multi-picture index (gain map, depth or preview images)' };
  if (n === 11 && startsWith(p, 'JP')) return { kind: 'metadata', id: 'APP11:JUMBF', label: latin1.decode(p).includes('c2pa') ? 'C2PA Content Credentials' : 'JUMBF box' };
  if (n === 13 && startsWith(p, 'Photoshop 3.0\0')) return { kind: 'metadata', id: 'APP13:IPTC', label: 'Photoshop / IPTC metadata' };
  if (n === 14 && startsWith(p, 'Adobe')) return { kind: 'structure', id: 'APP14:Adobe', label: 'Adobe color transform' };
  return { kind: 'metadata', id: app, label: `${app} vendor data` };
}

function parseJpeg(b: Uint8Array): Segment[] {
  const segs: Segment[] = [{ offset: 0, length: 2, kind: 'structure', id: 'SOI', label: 'Start of image', payload: b.subarray(0, 0) }];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error(`Corrupt JPEG: expected marker at byte ${i}`);
    while (b[i] === 0xff) i++; // fill bytes
    const m = b[i];
    const start = i - 1;
    i++;
    if (m === 0xd9) {
      segs.push({ offset: start, length: 2, kind: 'structure', id: 'EOI', label: 'End of image', payload: b.subarray(0, 0) });
      if (i < b.length) {
        segs.push({ offset: i, length: b.length - i, kind: 'trailer', id: 'trailer', label: 'Data after end of image (extra images or appended files)', payload: b.subarray(i) });
      }
      return segs;
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) continue; // standalone markers
    const len = (b[i] << 8) | b[i + 1];
    const payload = b.subarray(i + 2, i + len);
    let end = i + len;
    let info: Pick<Segment, 'kind' | 'id' | 'label'>;
    if (m >= 0xe0 && m <= 0xef) info = classifyJpegApp(m - 0xe0, payload);
    else if (m === 0xfe) info = { kind: 'metadata', id: 'COM', label: 'Comment' };
    else if (m === 0xda) {
      // Start of scan: entropy-coded data runs until the next real marker.
      // FF00 is an escaped 0xFF byte and FFD0–FFD7 are restart markers, both part of the scan.
      while (end < b.length - 1 && !(b[end] === 0xff && b[end + 1] !== 0 && !(b[end + 1] >= 0xd0 && b[end + 1] <= 0xd7))) end++;
      info = { kind: 'image', id: 'SOS', label: 'Compressed pixel data' };
    } else info = { kind: 'image', id: `FF${m.toString(16).toUpperCase()}`, label: 'Image coding tables' };
    segs.push({ offset: start, length: end - start, ...info, payload });
    i = end;
  }
  return segs;
}

// ---------- PNG ----------

const PNG_IMAGE = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'acTL', 'fcTL', 'fdAT']);
const PNG_COLOR = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'mDCV', 'cLLI', 'sBIT']);
const PNG_STRUCTURE = new Set(['pHYs', 'bKGD']);
const PNG_LABELS: Record<string, string> = {
  tEXt: 'Text', zTXt: 'Compressed text', iTXt: 'International text', eXIf: 'EXIF (camera, GPS, dates)',
  tIME: 'Last-modified time', caBX: 'C2PA Content Credentials', iCCP: 'ICC color profile',
};

function parsePng(b: Uint8Array): Segment[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const segs: Segment[] = [{ offset: 0, length: 8, kind: 'structure', id: 'signature', label: 'PNG signature', payload: b.subarray(0, 0) }];
  let i = 8;
  while (i + 8 <= b.length) {
    const len = dv.getUint32(i);
    const type = latin1.decode(b.subarray(i + 4, i + 8));
    const payload = b.subarray(i + 8, i + 8 + len);
    const critical = type.charCodeAt(0) < 97; // uppercase first letter
    const kind: SegmentKind = PNG_IMAGE.has(type) ? 'image' : PNG_COLOR.has(type) ? 'color'
      : PNG_STRUCTURE.has(type) || critical ? 'structure' : 'metadata';
    let label = PNG_LABELS[type] ?? (kind === 'image' ? 'Image data' : kind === 'color' ? 'Color information' : type);
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const kw = latin1.decode(payload.subarray(0, Math.max(0, payload.indexOf(0))));
      label = `${label}: “${kw}”`;
    }
    segs.push({ offset: i, length: 12 + len, kind, id: type, label, payload });
    i += 12 + len;
    if (type === 'IEND') break;
  }
  if (i < b.length) segs.push({ offset: i, length: b.length - i, kind: 'trailer', id: 'trailer', label: 'Data after end of image', payload: b.subarray(i) });
  return segs;
}

// ---------- WebP ----------

const WEBP_IMAGE = new Set(['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']);

function parseWebp(b: Uint8Array): Segment[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const segs: Segment[] = [{ offset: 0, length: 12, kind: 'structure', id: 'RIFF', label: 'RIFF header', payload: b.subarray(0, 0) }];
  const riffEnd = Math.min(b.length, 8 + dv.getUint32(4, true));
  let i = 12;
  while (i + 8 <= riffEnd) {
    const fourcc = latin1.decode(b.subarray(i, i + 4));
    const len = dv.getUint32(i + 4, true);
    const total = 8 + len + (len & 1);
    const payload = b.subarray(i + 8, i + 8 + len);
    let kind: SegmentKind = 'metadata';
    let label = `${fourcc.trim()} chunk`;
    if (WEBP_IMAGE.has(fourcc)) { kind = 'image'; label = 'Image data'; }
    else if (fourcc === 'VP8X') { kind = 'structure'; label = 'Extended format header'; }
    else if (fourcc === 'ICCP') { kind = 'color'; label = 'ICC color profile'; }
    else if (fourcc === 'EXIF') label = 'EXIF (camera, GPS, dates)';
    else if (fourcc === 'XMP ') label = 'XMP metadata';
    else if (fourcc === 'C2PA') label = 'C2PA Content Credentials';
    segs.push({ offset: i, length: total, kind, id: fourcc.trim(), label, payload });
    i += total;
  }
  if (riffEnd < b.length) segs.push({ offset: riffEnd, length: b.length - riffEnd, kind: 'trailer', id: 'trailer', label: 'Data after end of image', payload: b.subarray(riffEnd) });
  return segs;
}

// ---------- Rebuild ----------

export interface StripOptions {
  keepColorProfile: boolean;
  /** EXIF orientation to preserve (JPEG only). 1 or undefined writes nothing. */
  orientation?: number;
}

const isKept = (s: Segment, o: StripOptions) =>
  s.kind === 'image' || s.kind === 'structure' || (s.kind === 'color' && o.keepColorProfile);

export function stripMetadata(c: Container, o: StripOptions): Uint8Array {
  const kept = c.segments.filter((s) => isKept(s, o));
  const parts: Uint8Array[] = kept.map((s) => c.bytes.subarray(s.offset, s.offset + s.length));

  if (c.format === 'jpeg' && o.orientation && o.orientation !== 1) {
    // Without EXIF the viewer loses the "rotate this photo" flag, so a portrait
    // shot would show sideways. Write back a minimal EXIF holding only that tag.
    const at = kept[1]?.id === 'APP0:JFIF' ? 2 : 1;
    parts.splice(at, 0, minimalOrientationExif(o.orientation));
  }

  if (c.format === 'webp') {
    const body = concat(parts.slice(1)); // drop old RIFF header
    const vp8x = kept.find((s) => s.id === 'VP8X');
    if (vp8x) {
      const flagsAt = parts.slice(1, kept.indexOf(vp8x)).reduce((n, p) => n + p.length, 0) + 8;
      body[flagsAt] &= ~(0x08 | 0x04 | (o.keepColorProfile ? 0 : 0x20)); // EXIF, XMP, ICC flags
    }
    const header = new Uint8Array(12);
    header.set([0x52, 0x49, 0x46, 0x46]);
    new DataView(header.buffer).setUint32(4, body.length + 4, true);
    header.set([0x57, 0x45, 0x42, 0x50], 8);
    return concat([header, body]);
  }
  return concat(parts);
}

function minimalOrientationExif(orientation: number): Uint8Array {
  const b = new Uint8Array(36);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, 0xffe1);
  dv.setUint16(2, 34); // length excludes the marker
  b.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  b.set([0x4d, 0x4d, 0x00, 0x2a], 10); // big-endian TIFF header
  dv.setUint32(14, 8); // first IFD offset
  dv.setUint16(18, 1); // one entry
  dv.setUint16(20, 0x0112); // Orientation
  dv.setUint16(22, 3); // SHORT
  dv.setUint32(24, 1);
  dv.setUint16(28, orientation);
  dv.setUint32(32, 0); // no next IFD
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
