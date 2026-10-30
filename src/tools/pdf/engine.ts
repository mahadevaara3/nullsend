import { PDFDict, PDFDocument, PDFName, PDFArray, PDFRawStream, PDFStream, PDFString, PDFHexString, degrees, type PDFPage } from 'pdf-lib';
import exifr from 'exifr';
import { parseContainer, stripMetadata } from '../metadata/container';

export type PageSize = 'a4' | 'letter' | 'image';

export interface Source {
  name: string;
  kind: 'pdf' | 'image';
  bytes: Uint8Array;
  /** Loaded lazily and shared by every page taken from this file. */
  doc?: PDFDocument;
  /** What the file says about itself, for the "found in this file" list. */
  found: string[];
  pageCount: number;
  /** Images only: the format pdf-lib embeds, after any conversion. */
  image?: { bytes: Uint8Array; type: 'jpg' | 'png'; width: number; height: number };
}

export interface PageRef { src: Source; index: number; rotate: number }

const INFO_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'] as const;
const N = (s: string) => PDFName.of(s);

function text(v: unknown): string | undefined {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText().trim() || undefined;
  if (v instanceof PDFName) return v.decodeText();
  return undefined;
}

function pdfDate(s: string): string {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s);
  return m ? `${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}${m[4] ? ` ${m[4]}:${m[5] ?? '00'}` : ''}` : s;
}

export async function loadPdf(name: string, bytes: Uint8Array): Promise<Source> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test((e as Error).message)) throw new Error('This PDF is password-protected. Remove the password in your PDF reader first.');
    throw e;
  }
  if (doc.isEncrypted) throw new Error('This PDF is encrypted. Remove the password in your PDF reader first.');
  return { name, kind: 'pdf', bytes, doc, found: inspect(doc), pageCount: doc.getPageCount() };
}

/** Lists the identifying data a PDF carries, in plain words. */
export function inspect(doc: PDFDocument): string[] {
  const found: string[] = [];
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const k of INFO_KEYS) {
      const v = text(info.get(N(k)));
      if (v) found.push(`${k === 'CreationDate' ? 'Created' : k === 'ModDate' ? 'Modified' : k}: ${k.endsWith('Date') ? pdfDate(v) : v}`);
    }
  }
  const s = scan(doc);
  if (s.xmp) found.push(`XMP metadata (${s.xmp} block${s.xmp > 1 ? 's' : ''}): edit history, app and author details`);
  if (s.pieceInfo) found.push('Private app data (PieceInfo) left by the editing app');
  if (s.annotAuthors.size) found.push(`Comment authors: ${[...s.annotAuthors].join(', ')}`);
  if (s.jpegMeta) found.push(`${s.jpegMeta} embedded photo${s.jpegMeta > 1 ? 's' : ''} with camera EXIF or XMP (may include GPS)`);
  if (doc.context.trailerInfo.ID) found.push('Document ID that links copies of this file');
  return found;
}

interface Scan { xmp: number; pieceInfo: number; jpegMeta: number; annotAuthors: Set<string> }

function filters(dict: PDFDict): string[] {
  const f = dict.lookup(N('Filter'));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : ''));
  return [];
}

const isPlainJpeg = (o: unknown): o is PDFRawStream => o instanceof PDFRawStream && filters(o.dict).join() === 'DCTDecode';

function jpegHasMeta(bytes: Uint8Array): boolean {
  try { return parseContainer(bytes).segments.some((s) => s.kind === 'metadata' || s.kind === 'trailer'); } catch { return false; }
}

function scan(doc: PDFDocument): Scan {
  const s: Scan = { xmp: 0, pieceInfo: 0, jpegMeta: 0, annotAuthors: new Set() };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!dict) continue;
    if (dict.get(N('Type')) === N('Metadata') || dict.get(N('Subtype')) === N('XML')) s.xmp++;
    if (dict.has(N('PieceInfo'))) s.pieceInfo++;
    if (isAnnotWithAuthor(dict)) { const a = text(dict.get(N('T'))); if (a) s.annotAuthors.add(a); }
    if (isPlainJpeg(obj) && jpegHasMeta(obj.contents)) s.jpegMeta++;
  }
  return s;
}

// Form fields are also annotations (widgets), and their /T is the field name, not a person.
const isAnnotWithAuthor = (d: PDFDict) =>
  d.has(N('T')) && d.has(N('Rect')) && d.has(N('Subtype')) && d.get(N('Subtype')) !== N('Widget');

/** Removes everything inspect() reports. Page content, forms and links are untouched. */
function scrub(doc: PDFDocument) {
  const ctx = doc.context;
  delete ctx.trailerInfo.Info;
  delete ctx.trailerInfo.ID;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!dict) continue;
    if (dict.get(N('Type')) === N('Metadata') || dict.get(N('Subtype')) === N('XML')) { ctx.delete(ref); continue; }
    dict.delete(N('Metadata'));
    dict.delete(N('PieceInfo'));
    if (isAnnotWithAuthor(dict)) dict.delete(N('T'));
    // A photo placed in a PDF keeps its own EXIF. Cutting those segments out is lossless.
    if (isPlainJpeg(obj) && jpegHasMeta(obj.contents)) {
      const clean = stripMetadata(parseContainer(obj.contents), { keepColorProfile: true });
      dict.set(N('Length'), ctx.obj(clean.length));
      ctx.assign(ref, PDFRawStream.of(dict, clean));
    }
  }
}

export async function loadImage(file: File): Promise<Source> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const orientation = await exifr.orientation(file).catch(() => undefined);
  let image: Source['image'];
  if (file.type === 'image/jpeg' && (!orientation || orientation === 1)) {
    // Lossless: keep the JPEG as is, minus its EXIF/XMP (GPS, camera serials).
    const clean = stripMetadata(parseContainer(bytes), { keepColorProfile: true });
    const bmp = await createImageBitmap(file);
    image = { bytes: clean, type: 'jpg', width: bmp.width, height: bmp.height };
    bmp.close();
  } else if (file.type === 'image/png') {
    // pdf-lib decodes PNGs and stores only the pixels, so no chunks survive.
    const bmp = await createImageBitmap(file);
    image = { bytes, type: 'png', width: bmp.width, height: bmp.height };
    bmp.close();
  } else {
    // WebP, or a rotated JPEG: PDF has no rotation flag for images, so draw it upright.
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    image = { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'jpg', width: bmp.width, height: bmp.height };
    bmp.close();
  }
  return { name: file.name, kind: 'image', bytes, found: [], pageCount: 1, image };
}

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;

export interface BuildOptions { clean: boolean; pageSize: PageSize }

export async function build(pages: PageRef[], o: BuildOptions): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  // Copy every page needed from a file in one call, so shared fonts and images are copied once.
  const copied = new Map<PageRef, PDFPage>();
  for (const src of new Set(pages.map((p) => p.src))) {
    if (src.kind !== 'pdf') continue;
    const mine = pages.filter((p) => p.src === src);
    const result = await out.copyPages(src.doc!, mine.map((p) => p.index));
    mine.forEach((p, i) => copied.set(p, result[i]));
  }
  for (const p of pages) {
    let page = copied.get(p);
    if (page) out.addPage(page);
    else page = await addImagePage(out, p.src.image!, o.pageSize);
    page.setRotation(degrees((page.getRotation().angle + p.rotate) % 360));
  }
  if (o.clean) scrub(out);
  else {
    const first = pages.find((p) => p.src.kind === 'pdf')?.src.doc;
    const info = first && first.context.lookup(first.context.trailerInfo.Info);
    if (info instanceof PDFDict) out.context.trailerInfo.Info = out.context.register(info.clone(out.context));
  }
  return out.save();
}

async function addImagePage(out: PDFDocument, img: NonNullable<Source['image']>, size: PageSize): Promise<PDFPage> {
  const embedded = img.type === 'jpg' ? await out.embedJpg(img.bytes) : await out.embedPng(img.bytes);
  if (size === 'image') {
    // 96 dpi, the size the image shows at in a browser.
    const w = img.width * 0.75, h = img.height * 0.75;
    const page = out.addPage([w, h]);
    page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
    return page;
  }
  const [a, b] = SIZES[size];
  const landscape = img.width > img.height;
  const [pw, ph] = landscape ? [b, a] : [a, b];
  const margin = 24;
  const scale = Math.min((pw - 2 * margin) / img.width, (ph - 2 * margin) / img.height);
  const w = img.width * scale, h = img.height * scale;
  const page = out.addPage([pw, ph]);
  page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  return page;
}

/** Re-reads our own output, so "removed" is checked rather than assumed. */
export async function verify(bytes: Uint8Array): Promise<string[]> {
  return inspect(await PDFDocument.load(bytes, { updateMetadata: false }));
}
