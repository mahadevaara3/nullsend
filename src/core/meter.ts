// Live network meter. It watches everything this page sends and fetches, so a
// visitor can see for themselves that their files never leave the browser.
//
// Two sources feed it:
//   1. Resource Timing: every request the page makes (fetch, XHR, images,
//      scripts), including ones from libraries we didn't write.
//   2. Wrappers around fetch, XHR, sendBeacon and WebSocket, which count the
//      bytes in request bodies, i.e. the only way data can actually be uploaded.
// Requests made inside web workers are invisible to the page, so they are
// governed by the Content-Security-Policy header instead (connect-src 'self').

export interface MeterEntry {
  url: string;
  kind: string;
  received: number;
  offsite: boolean;
}

type Listener = () => void;

const state = {
  uploaded: 0,
  offsite: 0,
  received: 0,
  blocked: 0,
  entries: [] as MeterEntry[],
};
const listeners = new Set<Listener>();
const notify = () => listeners.forEach((l) => l());

export function onMeterChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const meterState = () => state;

const encoder = new TextEncoder();

function bodySize(body: unknown): number {
  if (body == null) return 0;
  if (typeof body === 'string') return encoder.encode(body).length;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return encoder.encode(body.toString()).length;
  if (body instanceof FormData) {
    let n = 0;
    body.forEach((v, k) => { n += encoder.encode(k).length + bodySize(v); });
    return n;
  }
  // A ReadableStream body can't be sized up front; count it as at least one byte
  // so the meter never shows a misleading zero.
  return 1;
}

function isLocal(url: string): boolean {
  return url.startsWith('blob:') || url.startsWith('data:');
}

function recordUpload(url: string, bytes: number) {
  if (bytes <= 0 || isLocal(url)) return;
  state.uploaded += bytes;
  notify();
}

let installed = false;

export function installMeter() {
  if (installed) return;
  installed = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.body != null) recordUpload(url, bodySize(init.body));
    else if (input instanceof Request && input.body) {
      input.clone().arrayBuffer().then((b) => recordUpload(url, b.byteLength), () => {});
    }
    return origFetch(input, init);
  };

  const xhrUrls = new WeakMap<XMLHttpRequest, string>();
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    xhrUrls.set(this, String(args[1]));
    return (origOpen as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    recordUpload(xhrUrls.get(this) ?? '', bodySize(body));
    return origSend.call(this, body);
  };

  const origBeacon = navigator.sendBeacon?.bind(navigator);
  if (origBeacon) {
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      recordUpload(String(url), Math.max(1, bodySize(data)));
      return origBeacon(url, data);
    };
  }

  const origWsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
    recordUpload(this.url, bodySize(data));
    return origWsSend.call(this, data);
  };

  const observe = (list: PerformanceEntryList) => {
    for (const e of list as PerformanceResourceTiming[]) {
      if (isLocal(e.name)) continue;
      let offsite = false;
      try { offsite = new URL(e.name).origin !== location.origin; } catch { /* ignore */ }
      // transferSize is 0 for cache hits; fall back to the decoded size so the
      // "downloaded from this site" figure reflects what the page actually used.
      const received = e.transferSize || e.encodedBodySize || 0;
      state.entries.push({ url: e.name, kind: e.initiatorType, received, offsite });
      state.received += received;
      if (offsite) state.offsite++;
    }
    notify();
  };
  const po = new PerformanceObserver((l) => observe(l.getEntries()));
  po.observe({ type: 'resource', buffered: true });

  document.addEventListener('securitypolicyviolation', () => {
    state.blocked++;
    notify();
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function mountMeter(host: HTMLElement) {
  host.classList.add('meter');
  host.innerHTML = `
    <button class="meter-pill" type="button" aria-expanded="false" aria-controls="meter-panel">
      <span class="meter-dot" aria-hidden="true"></span><span class="meter-label"></span>
    </button>
    <div class="meter-panel" id="meter-panel" hidden>
      <h3>Network meter</h3>
      <div class="meter-stats">
        <div><b data-k="uploaded"></b><span>uploaded from this page</span></div>
        <div><b data-k="offsite"></b><span>requests to other sites</span></div>
        <div><b data-k="received"></b><span>downloaded from this site</span></div>
        <div><b data-k="blocked"></b><span>blocked by the security policy</span></div>
      </div>
      <div class="meter-log" aria-label="Requests"></div>
      <p class="muted" style="margin:0">Downloads are this site's own code and models. The page's
        security policy only allows connections back to this site, so the browser blocks any attempt
        to send data elsewhere, including from background workers this meter can't see.
        Check it yourself: open DevTools → Network, or go offline after the page loads.</p>
    </div>`;
  const pill = host.querySelector<HTMLButtonElement>('.meter-pill')!;
  const panel = host.querySelector<HTMLDivElement>('.meter-panel')!;
  const label = host.querySelector<HTMLSpanElement>('.meter-label')!;
  const log = host.querySelector<HTMLDivElement>('.meter-log')!;
  const stat = (k: string) => host.querySelector<HTMLElement>(`[data-k="${k}"]`)!;

  pill.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    pill.setAttribute('aria-expanded', String(!panel.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!host.contains(e.target as Node)) { panel.hidden = true; pill.setAttribute('aria-expanded', 'false'); }
  });

  const render = () => {
    const s = state;
    label.textContent = `${formatBytes(s.uploaded)} uploaded · ${s.offsite} off-site`;
    host.classList.toggle('alert', s.uploaded > 0 || s.offsite > 0);
    stat('uploaded').textContent = formatBytes(s.uploaded);
    stat('offsite').textContent = String(s.offsite);
    stat('received').textContent = formatBytes(s.received);
    stat('blocked').textContent = String(s.blocked);
    if (!panel.hidden || log.childElementCount === 0) {
      log.replaceChildren(...s.entries.slice(-60).reverse().map((e) => {
        const row = document.createElement('div');
        if (e.offsite) row.className = 'off';
        const name = document.createElement('span');
        name.textContent = e.offsite ? e.url : new URL(e.url).pathname;
        name.title = e.url;
        const size = document.createElement('span');
        size.textContent = formatBytes(e.received);
        row.append(name, size);
        return row;
      }));
    }
  };
  onMeterChange(render);
  pill.addEventListener('click', render);
  render();
}
