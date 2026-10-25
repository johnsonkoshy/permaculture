/* EBPG Posting Helper: helpers shared by the popup, side panel and options page. */
(function (root) {
  'use strict';
  const shared = root.EBPG.shared;

  // Static icon markup only; never mixed with event text.
  const ICONS = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    out: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fill: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    panel: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 4v16" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };

  function iconButton(icon, label, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    if (cls) b.className = cls;
    b.innerHTML = ICONS[icon] || '';
    b.append(label);
    return b;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function say(el, text, bad) {
    el.classList.toggle('bad', !!bad);
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 30);
  }

  // Field rows with Copy buttons. Long text gets a Show all toggle.
  function renderRows(ul, draft, statusEl) {
    ul.replaceChildren(...shared.copyRows(draft).map(row => {
      const li = document.createElement('li');
      const lab = document.createElement('span');
      lab.className = 'lab';
      lab.textContent = row.label;
      const val = document.createElement('p');
      val.className = 'val';
      val.textContent = row.value;
      const acts = document.createElement('div');
      acts.className = 'acts';
      const btn = iconButton('copy', 'Copy');
      btn.setAttribute('aria-label', `Copy ${row.label.toLowerCase()}`);
      btn.addEventListener('click', async () => {
        const ok = await copy(row.value);
        btn.lastChild.textContent = ok ? 'Copied' : 'Copy';
        if (statusEl) say(statusEl, ok ? `${row.label} copied.` : 'Could not copy. Select the text instead.', !ok);
        setTimeout(() => { btn.lastChild.textContent = 'Copy'; }, 1600);
      });
      acts.appendChild(btn);
      if (row.value.length > 180 || row.value.split('\n').length > 4) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'link more';
        more.textContent = 'Show all';
        more.setAttribute('aria-expanded', 'false');
        more.addEventListener('click', () => {
          const open = li.classList.toggle('open');
          more.textContent = open ? 'Show less' : 'Show all';
          more.setAttribute('aria-expanded', String(open));
        });
        acts.appendChild(more);
      }
      li.append(lab, acts, val);
      return li;
    }));
  }

  let blob = { url: '', for: '' };
  function imageUrl(dataUrl) {
    if (!dataUrl) return '';
    if (blob.for === dataUrl) return blob.url;
    if (blob.url) URL.revokeObjectURL(blob.url);
    const parsed = shared.dataUrlToBytes(dataUrl);
    blob = { url: parsed ? URL.createObjectURL(new Blob([parsed.bytes], { type: parsed.type })) : '', for: dataUrl };
    return blob.url;
  }

  async function getDraft() {
    const r = await chrome.storage.local.get('draft');
    return (r && r.draft) || null;
  }

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(() => ({ ok: false, error: 'The helper did not answer. Try again.' }));
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  // "Workday #7 · Sunday, October 26, 2026 · 10:00 AM to 1:00 PM"
  function whenLine(d) {
    return [shared.longDate(d.date), shared.timeRange(d.start, d.end), shared.placeLine(d.place, '')].filter(Boolean).join(' · ');
  }

  root.EBPGPage = { ICONS, iconButton, copy, say, renderRows, imageUrl, getDraft, send, activeTab, whenLine };
})(globalThis);
