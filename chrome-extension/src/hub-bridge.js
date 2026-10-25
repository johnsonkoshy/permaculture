/*
 * EBPG Posting Helper: content script on the Event Hub (https://ebpg-event-hub.netlify.app
 * and http://localhost:8766). Runs at document_start.
 *
 * 1. Marks the page so the hub knows the helper is installed:
 *      document.documentElement.dataset.ebpgPoster = '<extension version>'
 * 2. Listens for the hub's fill request:
 *      window.postMessage({ source: 'ebpg-hub', type: 'fill', channel, draft }, location.origin)
 *    checks it, saves the draft in chrome.storage.local under 'draft', asks the service
 *    worker to open the site, and replies on the same window:
 *      { source: 'ebpg-poster', type: 'opened', channel }
 *      { source: 'ebpg-poster', type: 'opened', channel, imageDropped: true, note }  (image left out)
 *      { source: 'ebpg-poster', type: 'error', channel, message }
 *    A repeat of the same request (a double click) gets no reply of its own; the first
 *    request's reply answers it.
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./shared.js') : root.EBPG.shared);
  if (isNode) module.exports = api;
  else if (!root.__ebpgHubStarted && root.chrome && root.chrome.runtime && root.chrome.runtime.id) {
    root.__ebpgHubStarted = true;
    api.createHubBridge({
      win: root,
      doc: root.document,
      runtime: root.chrome.runtime,
      storage: root.chrome.storage.local,
      version: root.chrome.runtime.getManifest().version
    }).start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  'use strict';

  const REPEAT_MS = 1500;

  function createHubBridge(opts) {
    const { win, doc, runtime, storage, version } = opts;
    const now = opts.now || (() => Date.now());
    let last = { channel: null, at: -Infinity };
    const busy = new Set();

    function mark() {
      const el = doc.documentElement;
      if (!el) return false;
      if (el.dataset.ebpgPoster !== version) el.dataset.ebpgPoster = version;
      return true;
    }

    function reply(msg) {
      win.postMessage(Object.assign({ source: 'ebpg-poster' }, msg), win.location.origin);
    }

    function fail(channel, message) {
      reply({ type: 'error', channel, message });
    }

    async function onMessage(event) {
      const v = shared.validateHubMessage(event, win);
      if (v.ignore) return;
      if (!v.ok) return fail(v.channel, v.message);
      const t = now();
      // A double click: the first request is still being handled and will reply for both.
      // Replying here could reach the hub after "opened" and show an error for a tab that opened.
      if (busy.has(v.channel) || (v.channel === last.channel && t - last.at < REPEAT_MS)) return;
      if (t - last.at < REPEAT_MS) return fail(v.channel, 'Still opening the last one. Try again in a moment.');
      last = { channel: v.channel, at: t };
      busy.add(v.channel);
      try {
        await openFor(v, t);
      } finally {
        busy.delete(v.channel);
      }
    }

    async function openFor(v, t) {
      const name = (shared.CHANNEL_INFO[v.channel] || {}).name || 'the site';
      // After the helper is updated or reloaded, old pages lose their link to it.
      if (!runtime || !runtime.id) return fail(v.channel, 'The Posting Helper was just updated. Reload this page and try again.');
      const save = draft => storage.set({ draft: { channel: v.channel, timestamp: t, origin: win.location.origin, draft } });
      let note = v.imageNote || '';
      try {
        await save(v.draft);
      } catch (e) {
        // Usually the image is what does not fit. Save the rest so the fill still happens.
        if (!v.draft.imageDataUrl) return fail(v.channel, 'The helper could not save this event. Reload this page and try again.');
        try {
          await save(Object.assign({}, v.draft, { imageDataUrl: '' }));
          note = shared.IMAGE_NOTES.notSaved;
        } catch (e2) {
          return fail(v.channel, 'The helper could not save this event. Reload this page and try again.');
        }
      }
      let res = null;
      try { res = await runtime.sendMessage({ type: 'open', channel: v.channel }); } catch (e) { res = null; }
      if (res && res.ok) reply(note ? { type: 'opened', channel: v.channel, imageDropped: true, note } : { type: 'opened', channel: v.channel });
      else fail(v.channel, (res && res.error) || `The helper could not open ${name}. Reload this page and try again.`);
    }

    function start() {
      if (!mark()) {
        // Very early in loading there may be no <html> element yet.
        const mo = new win.MutationObserver(() => { if (mark()) mo.disconnect(); });
        mo.observe(doc, { childList: true });
      }
      doc.addEventListener('DOMContentLoaded', mark);
      win.addEventListener('message', onMessage);
    }

    return { start, mark, onMessage };
  }

  return { createHubBridge };
});
