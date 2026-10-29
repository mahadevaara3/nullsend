# Nullsend

Private file tools that run entirely in your browser, built so you don't have to trust the privacy claim. You can verify it.

**Live: https://mahadevaara3.github.io/nullsend/**

| Tool | What it does | How it runs |
|---|---|---|
| **Metadata X-ray** | Shows GPS location, device serial numbers, embedded thumbnails, C2PA credentials and AI-generation markers (including Stable Diffusion / ComfyUI prompts). Removes them **without re-encoding**. | Hand-written JPEG/PNG/WebP/HEIC container parser; [exifr](https://github.com/MikeKovarik/exifr) for EXIF fields |
| **Background remover** | Cuts out the subject and exports a transparent PNG, a solid color, or a "portrait mode" blur. | ISNet segmentation model (44 MB, quantized) on ONNX Runtime WebAssembly via [@imgly/background-removal](https://github.com/imgly/background-removal-js) |
| **Redact & Share** | Finds emails, phones, card numbers (Luhn-checked), Aadhaar/PAN, SSN, IBAN, IPs and API keys in screenshots, and blacks them out. Drag to add boxes. | [Tesseract.js](https://github.com/naptha/tesseract.js) OCR + pattern detection mapped back to word boxes |

## Why "verifiable" and not just "private"

Most "we don't upload your files" sites ask for trust. This one gives you ways to check:

1. **Live network meter.** Every page wraps `fetch`, `XMLHttpRequest`, `sendBeacon` and `WebSocket` to count request-body bytes, and watches Resource Timing for every request. The header pill shows bytes uploaded and requests to other sites. It stays at `0 B uploaded · 0 off-site`.
2. **A Content-Security-Policy that makes leaks impossible, not just absent.** `connect-src 'self'` means the browser itself refuses to send data to any other origin, even from a compromised dependency or a web worker. The policy is defined once in [`vite.config.ts`](vite.config.ts) and emitted both as a `<meta>` tag and as a `_headers` file.
3. **No third-party CDNs at runtime.** The OCR engine, language data, segmentation model and ONNX runtime are mirrored into `public/vendor` at build time ([`scripts/vendor.mjs`](scripts/vendor.mjs)), and every model chunk is checked against its SHA-256 hash.
4. **Works offline.** It's an installable PWA. Load a tool once, turn off your network, and it keeps working.
5. **AGPL-3.0.** Anyone who hosts a modified copy must publish their source too.

### Engineering details worth a look

- **Lossless metadata removal.** [`container.ts`](src/tools/metadata/container.ts) walks JPEG markers (including entropy-coded scan data, byte stuffing and restart markers), PNG chunks, WebP RIFF chunks and the HEIC item index ([`heif.ts`](src/tools/metadata/heif.ts)), then rebuilds the file from the kept segments. For HEIC, EXIF and XMP items are dropped from the index, their bytes are cut out of `mdat`, and every remaining item offset is shifted to match. The result is re-parsed and its pixel data compared byte for byte with the original, so the "Verified" message is computed, not assumed.
- **Rotation survives cleaning.** Removing EXIF normally loses the orientation flag, so portrait photos turn sideways. The cleaner writes back a hand-built 36-byte EXIF block holding only that tag.
- **Hidden data after the image.** Ultra HDR gain maps, depth maps and appended files after JPEG `EOI` are found and removed.
- **The redaction you see is the redaction you export.** The canvas is redrawn from the original with boxes burned in; no overlay layer, and no metadata in the PNG.
- **Offline GPS preview.** Shows the location on a local grid instead of loading map tiles, which would tell a map server where the photo was taken.

## Develop

```bash
npm install
npm run dev        # mirrors vendor assets on first run (~70 MB), then starts Vite
npm run build      # typecheck + production build into dist/
npm run preview
```

Every push to `master` deploys to GitHub Pages via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), built with `BASE_PATH=/nullsend/`.

GitHub Pages can't send custom headers, so there the CSP comes only from the `<meta>` tag, which doesn't cover web workers. The site also isn't cross-origin isolated there, so the background remover runs single-threaded (about 2–3× slower). For the full guarantees, deploy `dist/` to Cloudflare Pages, which reads `dist/_headers`.

Each build also writes `sitemap.xml`, `robots.txt` and [`llms.txt`](https://llmstxt.org), and adds canonical links, Open Graph tags and JSON-LD (`WebApplication`) to every page. All of this comes from [`build/discovery.ts`](build/discovery.ts) and the tool list in [`src/catalog.ts`](src/catalog.ts).

## Security notes

- The background-remover page alone allows `'unsafe-eval'`, because its `ndarray` dependency compiles helpers with `new Function()`. Its network rules are identical to every other page.
- Pixelation can sometimes be reversed for short text. The redactor defaults to solid boxes and says so.

## License

[AGPL-3.0](LICENSE.md). The background remover depends on `@imgly/background-removal`, which is also AGPL-3.0.
