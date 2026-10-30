import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { BASE } from '../../core/shell';
import type { PageRef, Source } from './engine';

GlobalWorkerOptions.workerSrc = workerUrl;

// Fonts, character maps and decoders come from this site (see scripts/vendor.mjs).
const vendor = new URL(`${BASE}vendor/pdfjs/`, location.href).href;
const docs = new WeakMap<Source, PDFDocumentLoadingTask>();

function open(src: Source) {
  let task = docs.get(src);
  if (!task) {
    task = getDocument({
      // PDF.js takes ownership of the buffer it's given, so hand it a copy.
      data: src.bytes.slice(),
      cMapUrl: `${vendor}cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${vendor}standard_fonts/`,
      wasmUrl: `${vendor}wasm/`, iccUrl: `${vendor}iccs/`,
      enableXfa: false,
    });
    docs.set(src, task);
  }
  return task.promise;
}

/** Draws a page at `width` CSS pixels (or at `scale` for exports), with its extra rotation applied. */
export async function renderPage(ref: PageRef, target: { width?: number; scale?: number }): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  if (ref.src.kind === 'image') {
    const bmp = await createImageBitmap(new Blob([ref.src.image!.bytes as BlobPart]));
    const turned = ref.rotate % 180 !== 0;
    const s = target.width ? target.width / (turned ? bmp.height : bmp.width) : 1;
    const w = bmp.width * s, h = bmp.height * s;
    canvas.width = Math.round(turned ? h : w);
    canvas.height = Math.round(turned ? w : h);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((ref.rotate * Math.PI) / 180);
    ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
    bmp.close();
    return canvas;
  }
  const page = await (await open(ref.src)).getPage(ref.index + 1);
  const rotation = (page.rotate + ref.rotate) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  const dpr = target.width ? Math.min(2, devicePixelRatio || 1) : 1;
  const scale = target.width ? (target.width / base.width) * dpr : target.scale!;
  const viewport = page.getViewport({ scale, rotation });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

export function closeSource(src: Source) {
  void docs.get(src)?.destroy();
  docs.delete(src);
}
