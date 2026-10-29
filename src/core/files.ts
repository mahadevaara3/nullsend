export interface DropZoneOptions {
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
}

// Turns an element into a file picker that also takes drag-and-drop and Ctrl+V,
// so a screenshot can go straight from the clipboard into a tool.
export function dropZone(el: HTMLElement, opts: DropZoneOptions) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = opts.accept;
  input.multiple = !!opts.multiple;
  input.className = 'visually-hidden';
  input.tabIndex = -1;
  el.append(input);
  el.tabIndex = 0;
  el.setAttribute('role', 'button');

  const accepts = (f: File) => opts.accept.split(',').some((a) => {
    a = a.trim();
    return a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a || f.name.toLowerCase().endsWith(a);
  });
  const take = (list: FileList | File[] | null | undefined) => {
    const files = Array.from(list ?? []).filter(accepts);
    if (files.length) opts.onFiles(opts.multiple ? files : files.slice(0, 1));
  };

  el.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { take(input.files); input.value = ''; });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); take(e.dataTransfer?.files); });
  document.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f)
      .map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}.png`, { type: f.type })));
    take(files);
  });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function withSuffix(name: string, suffix: string, ext?: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const oldExt = dot > 0 ? name.slice(dot + 1) : 'png';
  return `${base}-${suffix}.${ext ?? oldExt}`;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
