// Copies the heavy runtime assets (OCR engine, segmentation model, ONNX runtime)
// into public/vendor so the app serves them from its own origin. Nothing is
// loaded from a third-party CDN at runtime, which is what lets the CSP say
// connect-src 'self'.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'public', 'vendor');
// Read straight from node_modules: some packages don't export package.json.
const pkg = (name) => join(root, 'node_modules', name);

async function vendorTesseract() {
  const out = join(vendor, 'tesseract');
  const tjs = pkg('tesseract.js');
  const core = pkg('tesseract.js-core');
  const lang = pkg('@tesseract.js-data/eng');

  await mkdir(join(out, 'core'), { recursive: true });
  await mkdir(join(out, 'lang'), { recursive: true });
  await cp(join(tjs, 'dist', 'worker.min.js'), join(out, 'worker.min.js'));
  // We only run the LSTM engine, so only its builds are needed.
  for (const f of await readdir(core)) {
    if (f.endsWith('-lstm.wasm.js')) await cp(join(core, f), join(out, 'core', f));
  }
  // best_int: near "best" accuracy at a quarter of the size.
  await cp(join(lang, '4.0.0_best_int', 'eng.traineddata.gz'), join(out, 'lang', 'eng.traineddata.gz'));
  console.log('vendor: tesseract ready');
}

// @imgly/background-removal fetches its model and ONNX runtime as content-addressed
// chunks listed in resources.json. Since 1.5 the data package is no longer on npm,
// so we mirror the subset we use, once, and verify every chunk against its hash.
const IMGLY_VERSION = JSON.parse(
  await readFile(join(pkg('@imgly/background-removal'), 'package.json'), 'utf8'),
).version;
const IMGLY_BASE = `https://staticimgly.com/@imgly/background-removal-data/${IMGLY_VERSION}/dist/`;
const IMGLY_KEEP = [
  '/models/isnet_quint8',
  '/onnxruntime-web/ort-wasm-simd-threaded.wasm',
  '/onnxruntime-web/ort-wasm-simd-threaded.mjs',
];

async function vendorImgly() {
  const out = join(vendor, 'imgly');
  const manifestPath = join(out, 'resources.json');
  const stampPath = join(out, '.version');
  if (existsSync(stampPath) && (await readFile(stampPath, 'utf8')) === IMGLY_VERSION) {
    return console.log('vendor: imgly already mirrored');
  }
  await mkdir(out, { recursive: true });
  const all = await (await fetch(IMGLY_BASE + 'resources.json')).json();
  const keep = {};
  for (const key of IMGLY_KEEP) {
    if (!all[key]) throw new Error(`imgly resource missing: ${key}`);
    keep[key] = all[key];
    for (const chunk of all[key].chunks) {
      const dest = join(out, chunk.name);
      if (existsSync(dest) && (await stat(dest)).size > 0) continue;
      const res = await fetch(IMGLY_BASE + chunk.name);
      if (!res.ok) throw new Error(`fetch ${chunk.name}: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const hash = createHash('sha256').update(buf).digest('hex');
      if (hash !== chunk.hash) throw new Error(`hash mismatch for ${chunk.name}`);
      await writeFile(dest, buf);
    }
    console.log(`vendor: imgly ${key}`);
  }
  await writeFile(manifestPath, JSON.stringify(keep));
  await writeFile(stampPath, IMGLY_VERSION);
}

// PDF.js loads these on demand: character maps and the 14 standard fonts for PDFs
// that don't embed them, plus WebAssembly decoders for JPEG 2000, JBIG2 and color profiles.
async function vendorPdfjs() {
  const out = join(vendor, 'pdfjs');
  const src = pkg('pdfjs-dist');
  for (const dir of ['cmaps', 'standard_fonts', 'iccs']) await cp(join(src, dir), join(out, dir), { recursive: true });
  // The QuickJS build only runs scripts embedded in PDFs, which we never do.
  await cp(join(src, 'wasm'), join(out, 'wasm'), { recursive: true, filter: (f) => !f.includes('quickjs') });
  console.log('vendor: pdfjs ready');
}

await vendorTesseract();
await vendorPdfjs();
await vendorImgly();
