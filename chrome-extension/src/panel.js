/*
 * EBPG Posting Helper: the small floating panel shown on Partiful, Luma, Meetup, Facebook
 * and Hylo after a fill. It lives in a shadow root so the site's CSS cannot reach it, and
 * every piece of event text is set with textContent (never as HTML).
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./shared.js') : root.EBPG.shared);
  if (isNode) module.exports = api;
  else { root.EBPG = root.EBPG || {}; root.EBPG.panel = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  'use strict';

  // Static markup only (no event data): the Guild's sprout mark and two small icons.
  const MARK = '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle cx="32" cy="32" r="32" fill="#2F5D46"/><circle cx="45" cy="20" r="6.5" fill="#F2C14E"/><g fill="none" stroke="#F7F3E8" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 45 C20 40 27 40 33 43 C40 46 47 45 54 41"/><path d="M29 41 V24"/><path d="M29 29 C29 22.5 33.5 19 39.5 19 C39.5 25 35 29 29 29Z" fill="#A8C49A"/><path d="M29 33 C29 27.5 24.5 24 18.5 24.5 C18.5 30 23 33 29 33Z" fill="#A8C49A"/></g></svg>';
  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const CSS = `
:host { all: initial; }
.card {
  --bg: #FBF8EF; --raised: #FFFFFF; --ink: #1B2A21; --ink-2: #4A5A4F; --line: #DCD6C3;
  --accent: #2F5D46; --accent-ink: #FFFFFF; --soft: #E4EDDC; --soft-ink: #24493A; --warn: #8A5A12; --warn-soft: #FBEFC7;
  --focus: #2F5D46; --shadow: 0 1px 2px rgba(27,42,33,.08), 0 12px 32px rgba(27,42,33,.18);
  font: 14px/1.4 "Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
  width: min(360px, calc(100vw - 32px)); max-height: min(78vh, 620px); display: flex; flex-direction: column; overflow: hidden;
  box-sizing: border-box; text-align: left; letter-spacing: normal;
}
@media (prefers-color-scheme: dark) {
  .card { --bg: #16211A; --raised: #1D2A22; --ink: #E7ECDF; --ink-2: #AEBAA7; --line: #2F4035;
    --accent: #A8C49A; --accent-ink: #12201A; --soft: #22362A; --soft-ink: #CFE2C4; --warn: #F5DA92; --warn-soft: #3A3114;
    --focus: #A8C49A; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 12px 32px rgba(0,0,0,.5); }
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.head { display: flex; gap: 10px; align-items: flex-start; padding: 12px 12px 10px 14px; border-bottom: 1px solid var(--line); }
.mark { flex: 0 0 28px; width: 28px; height: 28px; margin-top: 1px; }
.mark svg { width: 28px; height: 28px; display: block; }
.msg { margin: 0; flex: 1; font-weight: 700; font-size: 14px; line-height: 1.35; }
.msg small { display: block; font-weight: 400; color: var(--ink-2); font-size: 12.5px; margin-top: 2px; }
button, a.btn { font: inherit; font-size: 13px; font-weight: 700; color: var(--ink); background: var(--raised); border: 1px solid var(--line);
  border-radius: 9px; min-height: 32px; padding: 5px 11px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; line-height: 1.2; }
button:hover, a.btn:hover { border-color: var(--accent); }
button:focus-visible, a.btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button.icon { width: 32px; padding: 0; justify-content: center; flex: 0 0 32px; }
button.icon svg { width: 18px; height: 18px; transition: transform .15s ease; }
.card.collapsed button.icon svg { transform: rotate(180deg); }
.card.collapsed .body { display: none; }
.body { overflow: auto; padding: 4px 14px 8px; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--line); }
li:last-child { border-bottom: 0; }
.lab { font-size: 12px; font-weight: 700; color: var(--ink-2); text-transform: uppercase; letter-spacing: .04em; display: flex; gap: 6px; align-items: center; }
.tag { font-size: 11px; letter-spacing: 0; text-transform: none; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: var(--soft); color: var(--soft-ink); display: inline-flex; gap: 3px; align-items: center; }
.tag svg { width: 11px; height: 11px; }
.tag.copy { background: transparent; border: 1px solid var(--line); color: var(--ink-2); }
.val { grid-column: 1; margin: 0; color: var(--ink); font-size: 13.5px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; white-space: pre-line; overflow-wrap: anywhere; }
li > button { grid-column: 2; grid-row: 1 / span 2; }
.manual { grid-column: 1 / -1; margin: 6px 0 0; display: grid; gap: 4px; }
.manual .hint { margin: 0; font-size: 12.5px; color: var(--warn); background: var(--warn-soft); border-radius: 6px; padding: 3px 7px; }
.manual textarea { font: inherit; font-size: 13px; color: var(--ink); background: var(--raised); border: 1px solid var(--line); border-radius: 8px;
  padding: 6px 8px; width: 100%; min-height: 72px; max-height: 180px; resize: vertical; white-space: pre-wrap; }
.manual textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.img { display: flex; gap: 10px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
.img img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); background: var(--raised); }
.img .t { flex: 1; font-size: 13px; color: var(--ink-2); }
.img .t b { display: block; color: var(--ink); }
.note { margin: 6px 0 4px; font-size: 12.5px; color: var(--ink-2); }
.foot { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 12px; border-top: 1px solid var(--line); background: var(--bg); flex-wrap: wrap; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { button.icon svg { transition: none; } }
`;

  function message(state) {
    const n = state.count || 0;
    if (state.used && n === 0) return { main: 'EBPG Posting Helper already filled this event in this tab.', sub: 'So nothing gets posted twice, it waits here. Click Fill again to fill this page, or copy each field below.' };
    if (n > 0) return { main: `EBPG Posting Helper filled ${n} ${n === 1 ? 'field' : 'fields'}. Review everything, then publish.`, sub: 'Anything it missed is below with a Copy button.' };
    if (state.looking) return { main: 'EBPG Posting Helper is looking for the form…', sub: 'Copy any field below while you wait.' };
    return { main: 'EBPG Posting Helper couldn’t find the form on this page yet.', sub: 'Open the create form and click Fill again, or copy each field below.' };
  }

  async function copyText(text, doc, shadow) {
    const win = doc.defaultView;
    try {
      if (win.navigator.clipboard && win.navigator.clipboard.writeText) { await win.navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall back below */ }
    try {
      const ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;width:1px;height:1px;';
      shadow.appendChild(ta);
      ta.select();
      const ok = typeof doc.execCommand === 'function' && doc.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) { return false; }
  }

  /*
   * createPanel(doc, { onFillAgain, onDismiss }) -> { render(state), destroy(), host, shadow }
   * state: { draft, count, filled: Set(rowKey), imageAttached, looking, used }
   */
  function createPanel(doc, handlers) {
    const h = handlers || {};
    const win = doc.defaultView;
    const host = doc.createElement('ebpg-posting-helper');
    host.setAttribute('data-ebpg-panel', '');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;display:block;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style>
<section class="card" role="region" aria-label="EBPG Posting Helper">
  <div class="head"><span class="mark">${MARK}</span><p class="msg"></p>
    <button type="button" class="icon" data-act="collapse" aria-expanded="true" aria-controls="ebpg-body" aria-label="Hide the field list">${CHEVRON}</button></div>
  <div class="body" id="ebpg-body">
    <ul></ul>
    <div class="img" hidden><img alt=""><span class="t"><b>Event image</b><span class="istate"></span></span><a class="btn" download>Download</a></div>
    <p class="note">The helper never clicks Publish. Check the date, time and place on the site, then publish when it looks right.</p>
  </div>
  <div class="foot"><button type="button" data-act="dismiss">Dismiss</button><button type="button" class="primary" data-act="fill">Fill again</button></div>
  <p class="sr" aria-live="polite"></p>
</section>`;
    const $ = sel => shadow.querySelector(sel);
    const card = $('.card'), list = $('ul'), status = $('.sr');
    let state = {}, blobUrl = '', blobFor = '', timers = [];

    function say(text) { status.textContent = ''; win.setTimeout(() => { status.textContent = text; }, 30); }

    $('[data-act="collapse"]').addEventListener('click', e => {
      const collapsed = card.classList.toggle('collapsed');
      e.currentTarget.setAttribute('aria-expanded', String(!collapsed));
      e.currentTarget.setAttribute('aria-label', collapsed ? 'Show the field list' : 'Hide the field list');
    });
    $('[data-act="dismiss"]').addEventListener('click', () => { destroy(); if (h.onDismiss) h.onDismiss(); });
    $('[data-act="fill"]').addEventListener('click', () => { if (h.onFillAgain) h.onFillAgain(); });
    $('.body').addEventListener('click', async e => {
      const btn = e.target.closest && e.target.closest('button[data-copy]');
      if (!btn) return;
      const row = shared.copyRows(state.draft).find(r => r.key === btn.getAttribute('data-copy'));
      if (!row) return;
      const ok = await copyText(row.value, doc, shadow);
      if (ok) {
        btn.textContent = 'Copied';
        say(`${row.label} copied.`);
        timers.push(win.setTimeout(() => { btn.textContent = 'Copy'; }, 1600));
        return;
      }
      // The site blocked copying: show the whole value, selected, for the keyboard shortcut.
      const mac = /Mac|iPhone|iPad/.test(win.navigator.platform || win.navigator.userAgent || '');
      const keys = mac ? 'Command C' : 'Ctrl C', shortcut = mac ? 'Command+C' : 'Ctrl+C';
      const li = btn.closest('li');
      let box = li.querySelector('.manual');
      if (!box) {
        box = doc.createElement('div');
        box.className = 'manual';
        const hint = doc.createElement('p');
        hint.className = 'hint';
        const ta = doc.createElement('textarea');
        ta.readOnly = true;
        ta.rows = 4;
        box.append(hint, ta);
        li.appendChild(box);
      }
      const ta = box.querySelector('textarea');
      box.querySelector('.hint').textContent = `Copying was blocked. The ${row.label.toLowerCase()} is selected below: press ${shortcut} to copy it.`;
      ta.value = row.value;
      ta.setAttribute('aria-label', `${row.label}, selected. Press ${keys} to copy it.`);
      try { ta.focus(); } catch (err) { /* not focusable */ }
      ta.select();
      say(`Could not copy the ${row.label.toLowerCase()}. It is selected in a box below. Press ${keys} to copy it.`);
    });

    let lastKey = '', lastDraft = null;
    function render(next) {
      state = Object.assign({}, state, next || {});
      if (!host.isConnected) (doc.body || doc.documentElement).appendChild(host);
      // Busy pages trigger many passes; only rebuild when something changed, so keyboard
      // focus and "Copied" labels are not lost.
      const key = JSON.stringify([state.count, [...(state.filled || [])].sort(), !!state.looking, !!state.imageAttached, !!state.used]);
      if (key === lastKey && state.draft === lastDraft) return;
      lastKey = key;
      lastDraft = state.draft;
      const m = message(state);
      const msg = $('.msg');
      msg.textContent = m.main;
      const small = doc.createElement('small');
      small.textContent = m.sub;
      msg.appendChild(small);

      const filled = state.filled || new Set();
      list.replaceChildren(...shared.copyRows(state.draft).map(row => {
        const li = doc.createElement('li');
        const lab = doc.createElement('span');
        lab.className = 'lab';
        lab.textContent = row.label;
        const tag = doc.createElement('span');
        if (filled.has(row.key)) { tag.className = 'tag'; tag.innerHTML = CHECK; tag.append('Filled'); }
        else { tag.className = 'tag copy'; tag.textContent = 'Copy and paste'; }
        lab.appendChild(tag);
        const val = doc.createElement('p');
        val.className = 'val';
        val.textContent = row.value;
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-copy', row.key);
        btn.setAttribute('aria-label', `Copy ${row.label.toLowerCase()}`);
        btn.textContent = 'Copy';
        li.append(lab, btn, val);
        return li;
      }));

      const img = $('.img');
      const url = state.draft && state.draft.imageDataUrl;
      img.hidden = !url;
      if (url) {
        if (blobFor !== url) {
          if (blobUrl) win.URL.revokeObjectURL(blobUrl);
          const parsed = shared.dataUrlToBytes(url, s => win.atob(s));
          blobUrl = parsed && win.URL.createObjectURL ? win.URL.createObjectURL(new win.Blob([parsed.bytes], { type: parsed.type })) : url;
          blobFor = url;
        }
        $('.img img').src = blobUrl;
        const a = $('.img a');
        a.href = blobUrl;
        a.setAttribute('download', shared.imageFileName(state.draft));
        a.setAttribute('aria-label', 'Download the event image');
        $('.istate').textContent = state.imageAttached ? 'Added to the form. Check it fits.' : 'Download it, then upload it on the site.';
      }
    }

    function destroy() {
      timers.forEach(t => win.clearTimeout(t));
      if (blobUrl && blobUrl.startsWith('blob:')) win.URL.revokeObjectURL(blobUrl);
      host.remove();
    }

    return { render, destroy, host, shadow };
  }

  return { createPanel, message };
});
