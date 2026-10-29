import exifr from 'exifr';
import type { Container } from './container';

export type Severity = 'high' | 'medium' | 'ai' | 'info';

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
}

export interface Report {
  findings: Finding[];
  gps?: { lat: number; lon: number; alt?: number };
  orientation?: number;
}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder();

async function inflate(data: Uint8Array): Promise<string> {
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
    return utf8.decode(await new Response(stream).arrayBuffer());
  } catch {
    return '';
  }
}

/** PNG text chunks as keyword → text. Generators like Stable Diffusion put the full prompt here. */
async function pngText(c: Container): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of c.segments) {
    const p = s.payload;
    const nul = p.indexOf(0);
    if (nul < 0) continue;
    const key = latin1.decode(p.subarray(0, nul));
    if (s.id === 'tEXt') out[key] = latin1.decode(p.subarray(nul + 1));
    else if (s.id === 'zTXt') out[key] = await inflate(p.subarray(nul + 2));
    else if (s.id === 'iTXt') {
      const compressed = p[nul + 1] === 1;
      let i = p.indexOf(0, nul + 3); // end of language tag
      i = p.indexOf(0, i + 1); // end of translated keyword
      const text = p.subarray(i + 1);
      out[key] = compressed ? await inflate(text) : utf8.decode(text);
    }
  }
  return out;
}

/** The raw TIFF block inside an EXIF segment, so exifr can read EXIF from PNG/WebP too. */
function exifTiff(c: Container): Uint8Array | undefined {
  if (c.format === 'jpeg') return undefined;
  const seg = c.segments.find((s) => s.id === 'eXIf' || s.id === 'EXIF');
  if (!seg) return undefined;
  const p = seg.payload;
  return latin1.decode(p.subarray(0, 6)) === 'Exif\0\0' ? p.subarray(6) : p;
}

const AI_TOOLS = [
  'Adobe Firefly', 'DALL·E', 'DALL-E', 'OpenAI', 'ChatGPT', 'Midjourney', 'Stable Diffusion', 'Imagen', 'Gemini',
  'Microsoft Designer', 'Bing Image Creator', 'Ideogram', 'Leonardo', 'NovelAI', 'ComfyUI', 'InvokeAI', 'Flux',
];

const val = (v: unknown) => (v instanceof Date ? v.toLocaleString() : Array.isArray(v) ? v.join(', ') : String(v));

export async function analyze(file: Blob, c: Container): Promise<Report> {
  const findings: Finding[] = [];
  const report: Report = { findings };
  const add = (severity: Severity, title: string, detail: string) => findings.push({ severity, title, detail });

  let tags: Record<string, unknown> = {};
  try {
    const source = exifTiff(c) ?? (c.format === 'jpeg' ? file : undefined);
    if (source) {
      tags = (await exifr.parse(source instanceof Uint8Array ? source.slice().buffer : source, {
        tiff: true, exif: true, gps: true, ifd1: true, xmp: true, iptc: true, icc: false, interop: false,
        mergeOutput: true, translateValues: true,
      })) ?? {};
    }
  } catch { /* unreadable EXIF: the segment map still shows it */ }
  const t = (k: string) => tags[k];

  if (typeof t('latitude') === 'number' && typeof t('longitude') === 'number') {
    report.gps = { lat: t('latitude') as number, lon: t('longitude') as number, alt: t('GPSAltitude') as number | undefined };
    add('high', 'Exact GPS location', `${report.gps.lat.toFixed(5)}, ${report.gps.lon.toFixed(5)}. This can point to your home or workplace.`);
  }
  const serials = ['BodySerialNumber', 'SerialNumber', 'LensSerialNumber', 'InternalSerialNumber']
    .filter((k) => t(k)).map((k) => `${k.replace('SerialNumber', ' serial')}: ${val(t(k))}`);
  if (serials.length) add('high', 'Device serial number', `${serials.join(' · ')}. It links every photo taken with the same device.`);
  const owner = t('CameraOwnerName') ?? t('OwnerName');
  if (owner) add('high', 'Camera owner name', val(owner));
  const author = [t('Artist'), t('creator'), t('By-line'), t('Copyright')].filter(Boolean).map(val);
  if (author.length) add('medium', 'Author / copyright', [...new Set(author)].join(' · '));
  const device = [t('Make'), t('Model')].filter(Boolean).map(val).join(' ');
  if (device) add('medium', 'Device', device + (t('LensModel') ? ` · ${val(t('LensModel'))}` : ''));
  const date = t('DateTimeOriginal') ?? t('CreateDate') ?? t('ModifyDate');
  if (date) add('medium', 'Date and time taken', val(date) + (t('OffsetTimeOriginal') ? ` (UTC${val(t('OffsetTimeOriginal'))})` : ''));
  if (t('Software') || t('CreatorTool')) add('info', 'Software', val(t('Software') ?? t('CreatorTool')));
  const place = [t('City'), t('State'), t('Country'), t('Sub-location')].filter(Boolean).map(val);
  if (place.length) add('high', 'Place name', place.join(', '));
  const thumb = c.format === 'jpeg' ? await exifr.thumbnail(file).catch(() => undefined) : undefined;
  if (thumb?.length || c.segments.some((s) => s.id === 'APP0:JFXX')) {
    add('medium', 'Embedded thumbnail', 'A small preview copy. After cropping or editing, it can still show the original.');
  }
  if (c.format === 'jpeg') report.orientation = (await exifr.orientation(file).catch(() => undefined)) ?? undefined;

  // AI and provenance markers live in XMP, C2PA manifests and PNG text chunks.
  const metaText = c.segments.filter((s) => s.kind === 'metadata').map((s) => latin1.decode(s.payload)).join('\n');
  const c2pa = c.segments.some((s) => s.label.startsWith('C2PA'));
  if (c2pa) {
    const gen = /claim_generator[^\x20-\x7e]{0,4}([\x20-\x7e]{3,80})/.exec(metaText)?.[1];
    add('ai', 'C2PA Content Credentials', `A signed record of how the image was made or edited${gen ? `, written by “${gen.trim()}”` : ''}.`);
  }
  if (/compositeWithTrainedAlgorithmicMedia/.test(metaText)) add('ai', 'Marked as AI-edited', 'IPTC Digital Source Type says AI was used to edit this image.');
  else if (/trainedAlgorithmicMedia/.test(metaText)) add('ai', 'Marked as AI-generated', 'IPTC Digital Source Type says this image was generated by AI.');

  if (c.format === 'png') {
    const text = await pngText(c);
    if (text.parameters) add('ai', 'Stable Diffusion prompt and settings', text.parameters.slice(0, 240) + (text.parameters.length > 240 ? '…' : ''));
    if (text.prompt || text.workflow) add('ai', 'ComfyUI workflow', 'The full node graph, including your prompt, is embedded in the file.');
    if (text.invokeai_metadata) add('ai', 'InvokeAI generation data', 'The prompt and model settings are embedded in the file.');
    for (const [k, v] of Object.entries(text)) {
      if (['parameters', 'prompt', 'workflow', 'invokeai_metadata', 'XML:com.adobe.xmp'].includes(k)) continue;
      add('info', `Text field “${k}”`, v.slice(0, 200) + (v.length > 200 ? '…' : ''));
    }
  }
  const tool = AI_TOOLS.find((n) => metaText.toLowerCase().includes(n.toLowerCase()));
  if (tool && !findings.some((f) => f.severity === 'ai' && f.detail.includes(tool))) {
    add('ai', `Mentions ${tool}`, 'The metadata names an AI image tool.');
  }

  const trailer = c.segments.find((s) => s.kind === 'trailer');
  if (trailer) add('medium', 'Hidden data after the image', `${trailer.length.toLocaleString()} bytes after the end of the image. Often extra images (HDR gain maps, depth maps) or appended files.`);
  const comment = c.segments.find((s) => s.id === 'COM');
  if (comment) add('info', 'Comment', latin1.decode(comment.payload).slice(0, 200));

  const order: Severity[] = ['high', 'ai', 'medium', 'info'];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return report;
}
