import { mountShell } from '../../core/shell';
import { NO_FILE, SHOW_VALUES, category, registerTools } from '../../core/webmcp';
import { dropZone, download, escapeHtml, withSuffix } from '../../core/files';
import { formatBytes } from '../../core/meter';
import { canTranscode, probe, run, verify, type Job, type Level, type Mode, type Probe, type Size } from './engine';
import './video.css';

mountShell('video');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = $('drop');
const status = $('status');
const editor = $('editor');
const player = $<HTMLVideoElement>('player');
const rStart = $<HTMLInputElement>('r-start');
const rEnd = $<HTMLInputElement>('r-end');
const tStart = $<HTMLInputElement>('t-start');
const tEnd = $<HTMLInputElement>('t-end');
const mode = $<HTMLSelectElement>('mode');
const result = $('result');
const exportBtn = $<HTMLButtonElement>('export');
const cancelBtn = $<HTMLButtonElement>('cancel');

let file: File | null = null;
let info: Probe | null = null;
let poster = '';
const signal: { cancel?: () => Promise<void> } = {};

function setStatus(text: string, fraction?: number) {
  status.hidden = false;
  status.classList.remove('failed');
  $('status-text').textContent = text;
  if (fraction !== undefined) $('bar').style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
}
function fail(e: unknown) {
  setStatus(`Something went wrong: ${(e as Error).message}`);
  status.classList.add('failed');
  cancelBtn.hidden = true;
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const parse = (v: string) => {
  const parts = v.trim().split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return NaN;
  return parts.reduce((t, n) => t * 60 + n, 0);
};

dropZone(drop, { accept: 'video/*,audio/*,.mkv,.mov', onFiles: ([f]) => open(f) });

async function open(f: File) {
  drop.classList.add('compact');
  editor.hidden = true;
  result.replaceChildren();
  $<HTMLImageElement>('scan-img').removeAttribute('src');
  setStatus(`Reading ${f.name}…`, 1);
  try {
    info = await probe(f);
    file = f;
  } catch (e) {
    fail(e);
    return;
  }
  URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(f);
  player.hidden = !info.video;
  const v = info.video, a = info.audio;
  $('info').textContent = [
    info.container,
    v && `${v.codec.toUpperCase()} ${v.width}×${v.height}${v.fps ? ` ${Math.round(v.fps)} fps` : ''}`,
    a && `${a.codec.toUpperCase()} ${a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels} ch`}`,
    fmt(info.duration), formatBytes(f.size),
  ].filter(Boolean).join(' · ');

  $<HTMLInputElement>('mute').checked = false;
  for (const r of [rStart, rEnd]) r.max = String(info.duration);
  rStart.value = '0';
  rEnd.value = String(info.duration);
  syncTrim();

  // Without a video track only the audio outputs make sense.
  for (const o of Array.from(mode.options)) {
    const needsVideo = o.value === 'mp4' || o.value === 'webm';
    const needsEncoder = o.value !== 'copy' && !(o.value === 'm4a' && a?.codec === 'aac');
    o.disabled = (needsVideo && !v) || (!canTranscode && needsEncoder) || (o.value !== 'copy' && !a && !needsVideo);
  }
  if (mode.selectedOptions[0]?.disabled) mode.value = 'copy';
  updateOptions();

  const found = info.found;
  $('found-card').hidden = !found.length;
  $('found').innerHTML = found.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  status.hidden = true;
  editor.hidden = false;
}

player.addEventListener('loadeddata', () => {
  // A small frame for the progress card.
  try {
    const c = document.createElement('canvas');
    c.width = 144;
    c.height = Math.round((144 * player.videoHeight) / player.videoWidth) || 144;
    c.getContext('2d')!.drawImage(player, 0, 0, c.width, c.height);
    poster = c.toDataURL('image/jpeg', 0.7);
  } catch { poster = ''; }
});

// ---------- Trim ----------

function syncTrim(from?: 'start' | 'end') {
  if (!info) return;
  let s = +rStart.value, e = +rEnd.value;
  const gap = Math.min(0.1, info.duration);
  if (e - s < gap) {
    if (from === 'start') s = e - gap; else e = s + gap;
    rStart.value = String(s);
    rEnd.value = String(e);
  }
  tStart.value = fmt(s);
  tEnd.value = fmt(e);
  const d = info.duration || 1;
  $('fill').style.left = `${(s / d) * 100}%`;
  $('fill').style.right = `${100 - (e / d) * 100}%`;
  const full = s <= 0.01 && e >= info.duration - 0.01;
  $('length').textContent = full ? `Full length ${fmt(info.duration)}` : `Keeping ${fmt(e - s)} of ${fmt(info.duration)}`;
  result.replaceChildren();
}

rStart.addEventListener('input', () => { syncTrim('start'); seek(+rStart.value); });
rEnd.addEventListener('input', () => { syncTrim('end'); seek(+rEnd.value); });
function seek(t: number) { if (info?.video) player.currentTime = t; }

for (const [input, range, which] of [[tStart, rStart, 'start'], [tEnd, rEnd, 'end']] as const) {
  input.addEventListener('change', () => {
    const t = parse(input.value);
    if (Number.isFinite(t)) range.value = String(Math.max(0, Math.min(info?.duration ?? 0, t)));
    syncTrim(which);
  });
}
$('set-start').addEventListener('click', () => { rStart.value = String(player.currentTime); syncTrim('start'); });
$('set-end').addEventListener('click', () => { rEnd.value = String(player.currentTime); syncTrim('end'); });

// ---------- Options ----------

const HINTS: Record<Mode, string> = {
  copy: 'Fastest and lossless: the video is copied, not re-encoded. Cuts land on the nearest key frame, so the start may be up to a couple of seconds early.',
  mp4: 'Re-encodes to H.264 when your browser supports it, the format that plays almost everywhere. Cuts are exact.',
  webm: 'Re-encodes to VP9. Smaller files, but some Apple apps won\'t play them.',
  m4a: 'Keeps only the sound. AAC audio, which most phones record, is copied without re-encoding.',
  wav: 'Uncompressed audio, for editing in another app. Large files.',
};

function updateOptions() {
  const m = mode.value as Mode;
  const encodes = m === 'mp4' || m === 'webm';
  $('mode-hint').textContent = HINTS[m] + (!canTranscode && m === 'copy' ? ' This browser can\'t encode video, so other formats are unavailable.' : '');
  $('encode-opts').hidden = !(encodes || (m === 'm4a' && info?.audio?.codec !== 'aac'));
  $('size-field').hidden = !encodes;
  $('mute-field').hidden = m === 'm4a' || m === 'wav' || !info?.audio;
  result.replaceChildren();
}
mode.addEventListener('change', updateOptions);

// ---------- Export ----------

async function exportVideo(): Promise<string> {
  if (!file || !info) throw new Error(NO_FILE);
  const job: Job = {
    mode: mode.value as Mode,
    start: +rStart.value,
    end: +rEnd.value,
    size: ($<HTMLSelectElement>('size').value === 'original' ? 'original' : +$<HTMLSelectElement>('size').value) as Size,
    level: $<HTMLSelectElement>('level').value as Level,
    clean: $<HTMLInputElement>('clean').checked,
    mute: $<HTMLInputElement>('mute').checked,
  };
  exportBtn.disabled = true;
  result.replaceChildren();
  if (poster) $<HTMLImageElement>('scan-img').src = poster;
  cancelBtn.hidden = false;
  const t0 = performance.now();
  setStatus(job.mode === 'copy' ? 'Copying…' : 'Encoding on your device… 0%', 0);
  try {
    const out = await run(info, job, (f) => setStatus(`${job.mode === 'copy' ? 'Copying' : 'Encoding on your device'}… ${Math.round(f * 100)}%`, f), signal);
    const left = job.clean ? await verify(out.bytes) : [];
    download(new Blob([out.bytes as BlobPart], { type: out.mime }), withSuffix(file.name, job.mode === 'copy' && job.clean && job.start <= 0.01 && job.end >= info.duration - 0.01 ? 'clean' : 'edited', out.ext));
    const change = out.bytes.length / file.size - 1;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    result.innerHTML = `<div class="notice ${left.length ? 'danger' : ''}">
      ${formatBytes(file.size)} → <b>${formatBytes(out.bytes.length)}</b> (${change <= 0 ? '−' : '+'}${Math.abs(Math.round(change * 100))}%) in ${secs} s.
      ${out.discarded.length ? `<br>⚠ Left out: ${out.discarded.join(', ')} track (not supported in this format).` : ''}
      ${!job.clean ? '<br>Metadata kept, as you chose.' : left.length ? `<br>⚠ Still found: ${left.map(escapeHtml).join('; ')}` : '<br>✓ Verified: a re-scan of the new file finds no location, device or date tags.'}</div>`;
    status.hidden = true;
    return result.textContent!.replace(/\s+/g, ' ').trim();
  } catch (e) {
    if ((e as Error).name === 'ConversionCanceledError') { status.hidden = true; return 'Canceled.'; }
    fail(e);
    throw e;
  } finally {
    exportBtn.disabled = false;
    cancelBtn.hidden = true;
    signal.cancel = undefined;
  }
}

exportBtn.addEventListener('click', () => void exportVideo().catch(() => {}));

cancelBtn.addEventListener('click', () => { void signal.cancel?.(); });

// ---------- WebMCP ----------

function setTrim(start?: number, end?: number) {
  if (!info) throw new Error(NO_FILE);
  if (start !== undefined) rStart.value = String(Math.max(0, Math.min(info.duration, start)));
  if (end !== undefined) rEnd.value = String(Math.max(0, Math.min(info.duration, end)));
  if (+rEnd.value <= +rStart.value) throw new Error(`End must be after start (video is ${info.duration.toFixed(2)} s long).`);
  syncTrim();
}

registerTools([
  {
    name: 'inspect_video',
    title: 'Inspect the loaded video',
    description: 'Describes the video the user loaded on this page: container, codecs, resolution, duration, size, the current trim range, the output formats this browser can make, and hidden metadata such as GPS location, device and recording date.',
    inputSchema: { type: 'object', properties: { ...SHOW_VALUES } },
    readOnly: true,
    execute: ({ show_values }) => {
      if (!file || !info) return NO_FILE;
      return {
        file: file.name, bytes: file.size, container: info.container, duration_s: +info.duration.toFixed(3),
        video: info.video ?? null, audio: info.audio ?? null,
        trim: { start_s: +rStart.value, end_s: +rEnd.value },
        available_outputs: Array.from(mode.options).filter((o) => !o.disabled).map((o) => o.value),
        metadata: info.found.map((f) => category(f, !!show_values)),
      };
    },
  },
  {
    name: 'set_trim',
    title: 'Set the trim range',
    description: 'Sets which part of the video to keep, in seconds. The page shows the new range.',
    inputSchema: { type: 'object', properties: { start: { type: 'number', description: 'Seconds. Omit to keep the current start.' }, end: { type: 'number', description: 'Seconds. Omit to keep the current end.' } } },
    execute: ({ start, end }) => { setTrim(start, end); return `Keeping ${(+rEnd.value - +rStart.value).toFixed(2)} s, from ${(+rStart.value).toFixed(2)} s to ${(+rEnd.value).toFixed(2)} s.`; },
  },
  {
    name: 'export_video',
    title: 'Export the video',
    description: 'Makes the output file on the user\'s device and downloads it. "copy" is fast and lossless (cuts snap to key frames); "mp4"/"webm" re-encode with exact cuts and can shrink the file; "m4a"/"wav" keep only the audio. Optionally sets the trim range first.',
    inputSchema: {
      type: 'object',
      properties: {
        output: { type: 'string', enum: ['copy', 'mp4', 'webm', 'm4a', 'wav'], description: 'Default copy.' },
        resolution: { type: 'string', enum: ['original', '1080', '720', '480'], description: 'For mp4/webm. Never upscales. Default original.' },
        quality: { type: 'string', enum: ['high', 'medium', 'small'], description: 'For mp4/webm. Default medium.' },
        mute: { type: 'boolean', description: 'Remove the sound. Default false.' },
        remove_metadata: { type: 'boolean', description: 'Remove location, device and date tags. Default true.' },
        start: { type: 'number', description: 'Trim start in seconds.' },
        end: { type: 'number', description: 'Trim end in seconds.' },
      },
    },
    consequential: true,
    execute: ({ output = 'copy', resolution = 'original', quality = 'medium', mute = false, remove_metadata = true, start, end }) => {
      if (!info) throw new Error(NO_FILE);
      const option = Array.from(mode.options).find((o) => o.value === output);
      if (!option || option.disabled) throw new Error(`"${output}" isn't available for this file in this browser.`);
      if (start !== undefined || end !== undefined) setTrim(start, end);
      mode.value = output;
      updateOptions();
      $<HTMLSelectElement>('size').value = resolution;
      $<HTMLSelectElement>('level').value = quality;
      $<HTMLInputElement>('mute').checked = mute;
      $<HTMLInputElement>('clean').checked = remove_metadata;
      return exportVideo();
    },
  },
]);
