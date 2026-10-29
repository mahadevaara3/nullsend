// The tool list, shared by the site header, the build's sitemap, llms.txt and
// structured data. Paths are relative to the site's base URL.

export const SITE_NAME = 'Nullsend';
export const REPO_URL = 'https://github.com/mahadevaara3/nullsend';
export const TAGLINE = 'Private file tools that run entirely in your browser. Nothing is uploaded, and you can verify it.';

export const TOOLS = [
  {
    id: 'metadata',
    path: 'tools/metadata/',
    icon: '🔍',
    name: 'Metadata X-ray',
    tag: 'Photos',
    category: 'UtilitiesApplication',
    blurb: 'See the GPS location, camera serial number and AI/C2PA markers hidden in a photo, then remove them without re-encoding.',
    features: [
      'Shows GPS location, device serial numbers, dates, embedded thumbnails and software',
      'Detects C2PA Content Credentials and AI-generation markers, including Stable Diffusion and ComfyUI prompts',
      'Removes metadata from JPEG, PNG and WebP without re-encoding, so image quality is unchanged',
      'Keeps the rotation flag so portrait photos stay upright',
    ],
  },
  {
    id: 'background',
    path: 'tools/background-remover/',
    icon: '✂️',
    name: 'Background remover',
    tag: 'AI · on-device',
    category: 'MultimediaApplication',
    blurb: 'Cut out the subject of any photo with a neural network that runs on your own machine. Export a transparent PNG.',
    features: [
      'Runs an ISNet segmentation model on your device with ONNX Runtime WebAssembly',
      'Exports a transparent PNG, a solid color background or a blurred "portrait mode" background',
      'Before/after comparison slider',
      'The model is downloaded once from this site and cached for offline use',
    ],
  },
  {
    id: 'redact',
    path: 'tools/redact/',
    icon: '🕶️',
    name: 'Redact & Share',
    tag: 'Screenshots',
    category: 'UtilitiesApplication',
    blurb: 'Finds emails, phone numbers, card numbers and API keys in a screenshot with on-device OCR, and blacks them out.',
    features: [
      'On-device OCR with Tesseract finds text in screenshots',
      'Detects emails, phone numbers, card numbers (Luhn-checked), Aadhaar, PAN, SSN, IBAN, IP addresses and API keys',
      'Solid or pixelated redaction, plus drag-to-cover for anything else',
      'Exports a fresh PNG with no hidden text and no metadata',
    ],
  },
] as const;

export type ToolId = (typeof TOOLS)[number]['id'];
