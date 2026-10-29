import { TOOLS, mountShell } from './core/shell';
import { escapeHtml } from './core/files';

mountShell();

document.getElementById('tools')!.innerHTML = TOOLS.map((t) => `
  <a class="card tool-card" href="${t.href}">
    <span class="icon" aria-hidden="true">${t.icon}</span>
    <span class="tag">${escapeHtml(t.tag)}</span>
    <h3>${escapeHtml(t.name)}</h3>
    <p>${escapeHtml(t.blurb)}</p>
  </a>`).join('');
