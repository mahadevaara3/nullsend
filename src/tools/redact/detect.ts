// Finds sensitive values in OCR output and maps them back to pixel boxes.

export interface Box { x: number; y: number; w: number; h: number }

export interface Word { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }

export interface Detection {
  type: string;
  text: string;
  box: Box;
}

interface Pattern {
  type: string;
  re: RegExp;
  valid?: (m: string) => boolean;
}

const digits = (s: string) => s.replace(/\D/g, '');

function luhn(s: string): boolean {
  const d = digits(s);
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

// Order matters: earlier patterns claim their text first, so a card number is
// labelled as a card rather than also as a phone number.
const PATTERNS: Pattern[] = [
  { type: 'Card number', re: /\b(?:\d[ -]?){12,18}\d\b/g, valid: (m) => digits(m).length >= 13 && luhn(m) },
  { type: 'API key / token', re: /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g },
  { type: 'Email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { type: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  { type: 'Aadhaar number', re: /\b[2-9]\d{3} ?\d{4} ?\d{4}\b/g },
  { type: 'PAN', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: 'US SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'IP address', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  {
    type: 'Phone number',
    re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,5}\)[ .-]?)?\d{2,5}(?:[ .-]?\d{2,5}){1,4}/g,
    // Long digit runs with a + or a typical phone length, but not dates or times.
    valid: (m) => {
      const n = digits(m).length;
      if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/.test(m.trim())) return false;
      return m.trim().startsWith('+') ? n >= 8 && n <= 15 : n >= 10 && n <= 13;
    },
  },
  {
    type: 'Possible secret',
    re: /\b[A-Za-z0-9_-]{32,}\b/g,
    valid: (m) => /\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m),
  },
];

export function detect(lines: Word[][], pad = 3): Detection[] {
  const found: Detection[] = [];
  for (const words of lines) {
    // Rebuild the line as text, remembering where each word starts and ends.
    let text = '';
    const spans = words.map((w) => {
      if (text) text += ' ';
      const start = text.length;
      text += w.text;
      return { start, end: text.length, w };
    });
    const claimed: [number, number][] = [];
    for (const p of PATTERNS) {
      for (const m of text.matchAll(p.re)) {
        const start = m.index!, end = start + m[0].length;
        if (claimed.some(([a, b]) => start < b && end > a)) continue;
        if (p.valid && !p.valid(m[0])) continue;
        const hit = spans.filter((s) => s.start < end && s.end > start);
        if (!hit.length) continue;
        claimed.push([start, end]);
        const x0 = Math.min(...hit.map((s) => s.w.bbox.x0)) - pad;
        const y0 = Math.min(...hit.map((s) => s.w.bbox.y0)) - pad;
        const x1 = Math.max(...hit.map((s) => s.w.bbox.x1)) + pad;
        const y1 = Math.max(...hit.map((s) => s.w.bbox.y1)) + pad;
        found.push({ type: p.type, text: m[0], box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
      }
    }
  }
  return found;
}
