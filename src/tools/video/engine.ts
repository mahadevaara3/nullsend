import {
  ALL_FORMATS, BlobSource, BufferSource, BufferTarget, Conversion, Input, Output,
  Mp4OutputFormat, WebMOutputFormat, MkvOutputFormat, WavOutputFormat,
  QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_LOW,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
  type MetadataTags, type OutputFormat, type Quality,
} from 'mediabunny';

export interface Probe {
  input: Input;
  duration: number;
  container: string;
  mime: string;
  video?: { codec: string; width: number; height: number; fps?: number };
  audio?: { codec: string; channels: number; sampleRate: number };
  found: string[];
}

export type Mode = 'copy' | 'mp4' | 'webm' | 'm4a' | 'wav';
export type Size = 'original' | 1080 | 720 | 480;
export type Level = 'high' | 'medium' | 'small';

export interface Job {
  mode: Mode;
  start: number;
  end: number;
  size: Size;
  level: Level;
  clean: boolean;
  /** Mutes the output. Ignored for audio-only modes. */
  mute: boolean;
}

export const canTranscode = typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';

const LEVELS: Record<Level, Quality> = { high: QUALITY_HIGH, medium: QUALITY_MEDIUM, small: QUALITY_LOW };

export async function probe(file: File): Promise<Probe> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const format = await input.getFormat().catch(() => null);
  if (!format) throw new Error('This file type isn\'t supported. Use MP4, MOV, WebM, MKV or a common audio format.');
  const [v, a] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
  const short = { 'video/quicktime': 'MOV', 'video/mp4': 'MP4', 'video/webm': 'WebM', 'video/x-matroska': 'MKV' }[format.mimeType];
  const p: Probe = { input, duration: await input.computeDuration(), container: short ?? format.name, mime: format.mimeType, found: [] };
  if (v) {
    const stats = await v.computePacketStats(50).catch(() => null);
    p.video = { codec: v.codec ?? 'unknown', width: v.displayWidth, height: v.displayHeight, fps: stats?.averagePacketRate };
  }
  if (a) p.audio = { codec: a.codec ?? 'unknown', channels: a.numberOfChannels, sampleRate: a.sampleRate };
  p.found = describe(await input.getMetadataTags().catch(() => ({}) as MetadataTags));
  return p;
}

// ISO 6709, as phones write it: "+12.9716+077.5946+920.000/".
function iso6709(s: string): string | undefined {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(s.trim());
  return m ? `${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}` : undefined;
}

const LABELS: [RegExp, string][] = [
  [/location\.ISO6709$|^©xyz$|^location$/i, 'GPS location'],
  [/\.make$|^make$/i, 'Device make'],
  [/\.model$|^model$/i, 'Device model'],
  [/\.software$|^©swr$|^encoder$|^software$/i, 'Software'],
  [/creationdate$|^©day$|^creation_time$/i, 'Recorded'],
  [/location\.name$/i, 'Place name'],
  [/author$|^©aut$|^artist$/i, 'Author'],
];

/** Lists identifying tags in plain words. */
export function describe(tags: MetadataTags): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [key, raw] of Object.entries(tags.raw ?? {})) {
    const value = typeof raw === 'string' ? raw : Array.isArray(raw) && typeof raw[0] === 'string' ? raw.join(', ') : undefined;
    const hit = LABELS.find(([re]) => re.test(key));
    if (!hit || !value) continue;
    const label = hit[1];
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(`${label}: ${label === 'GPS location' ? iso6709(value) ?? value : value}`);
  }
  if (tags.title && !seen.has('Title')) out.push(`Title: ${tags.title}`);
  if (tags.comment) out.push(`Comment: ${tags.comment}`);
  if (tags.date && !seen.has('Recorded')) out.push(`Date: ${tags.date.toLocaleString()}`);
  return out;
}

function outputFormat(mode: Mode, p: Probe): { format: OutputFormat; ext: string; mime: string } {
  switch (mode) {
    case 'mp4': return { format: new Mp4OutputFormat({ fastStart: 'in-memory' }), ext: 'mp4', mime: 'video/mp4' };
    case 'webm': return { format: new WebMOutputFormat(), ext: 'webm', mime: 'video/webm' };
    case 'm4a': return { format: new Mp4OutputFormat({ fastStart: 'in-memory' }), ext: 'm4a', mime: 'audio/mp4' };
    case 'wav': return { format: new WavOutputFormat(), ext: 'wav', mime: 'audio/wav' };
    case 'copy':
      // Keep the container family so every track can be copied as is.
      if (/webm/.test(p.mime)) return { format: new WebMOutputFormat(), ext: 'webm', mime: 'video/webm' };
      if (/matroska/.test(p.mime)) return { format: new MkvOutputFormat(), ext: 'mkv', mime: 'video/x-matroska' };
      return { format: new Mp4OutputFormat({ fastStart: 'in-memory' }), ext: p.video ? 'mp4' : 'm4a', mime: p.video ? 'video/mp4' : 'audio/mp4' };
  }
}

/** Shorter side to the target, never upscaling. Phones film portrait, so "720p" means 720 wide there. */
function resize(p: Probe, size: Size): { width?: number; height?: number } {
  if (size === 'original' || !p.video) return {};
  const { width, height } = p.video;
  if (Math.min(width, height) <= size) return {};
  return width < height ? { width: size } : { height: size };
}

export interface Result { bytes: Uint8Array; ext: string; mime: string; discarded: string[] }

export async function run(p: Probe, job: Job, onProgress: (f: number) => void, signal: { cancel?: () => Promise<void> }): Promise<Result> {
  const { format, ext, mime } = outputFormat(job.mode, p);
  const output = new Output({ format, target: new BufferTarget() });
  const audioOnly = job.mode === 'm4a' || job.mode === 'wav';
  const reencode = job.mode === 'mp4' || job.mode === 'webm';
  const dims = resize(p, job.size);

  const videoCodec = reencode && p.video
    ? await getFirstEncodableVideoCodec(job.mode === 'mp4' ? ['avc', 'hevc', 'vp9', 'av1'] : ['vp9', 'vp8', 'av1'], { width: dims.width ?? p.video.width, height: dims.height ?? p.video.height })
    : null;
  if (reencode && p.video && !videoCodec) throw new Error('This browser can\'t encode video in that format. Try the other format, or "Original" to keep the video as is.');
  // AAC going into M4A is copied as is, so it needs no encoder (Firefox and Linux Chrome have none for AAC).
  const audioCodec = job.mode === 'wav' ? 'pcm-s16'
    : job.mode === 'm4a' && p.audio?.codec === 'aac' ? 'aac'
    : (reencode || job.mode === 'm4a') && p.audio ? await getFirstEncodableAudioCodec(job.mode === 'webm' ? ['opus', 'vorbis'] : ['aac', 'opus']) : null;

  const conversion = await Conversion.init({
    input: p.input,
    output,
    tracks: 'primary',
    trim: { start: job.start, end: job.end },
    video: audioOnly ? { discard: true }
      : reencode ? { codec: videoCodec!, bitrate: LEVELS[job.level], ...dims, fit: 'contain' }
      : {},
    audio: job.mute && !audioOnly ? { discard: true }
      : audioCodec === 'aac' && job.mode === 'm4a' && p.audio?.codec === 'aac' ? { codec: 'aac' } // a bitrate would force re-encoding
      : audioCodec ? { codec: audioCodec, bitrate: LEVELS[job.level] } : {},
    // Lossless mode cuts at the nearest key frame before the start, so nothing is re-encoded.
    copy: reencode ? false : { mode: 'preferred', boundaryPolicy: 'expand' },
    tags: job.clean ? {} : undefined,
    showWarnings: false,
  });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason.replace(/_/g, ' ')}`).join('; ');
    throw new Error(`Can't make this file: ${why || 'no usable tracks'}.`);
  }
  conversion.onProgress = onProgress;
  signal.cancel = () => conversion.cancel();
  await conversion.execute();
  const discarded = conversion.discardedTracks.filter((d) => d.reason !== 'discarded_by_user').map((d) => d.track.type);
  return { bytes: new Uint8Array(output.target.buffer!), ext, mime, discarded };
}

/** Re-reads our own output, so "removed" is checked rather than assumed. */
export async function verify(bytes: Uint8Array): Promise<string[]> {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  return describe(await input.getMetadataTags().catch(() => ({}) as MetadataTags));
}
