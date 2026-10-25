/*
 * EBPG Posting Helper: content script on Partiful, Luma, Meetup, Facebook and Hylo.
 * It only acts in a tab the helper opened (or one you asked it to fill from the popup or
 * side panel), and only while the draft is fresh. It fills the form, shows the floating
 * panel, keeps watching for late-loading fields for about 20 seconds, then stops.
 * A tab fills by itself only once: later pages in it show the panel and wait for Fill again.
 * With no fresh event saved it does nothing on the page and does not wake the service worker.
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const api = isNode
    ? factory(require('./shared.js'), require('./filler.js'), require('./panel.js'))
    : factory(root.EBPG.shared, root.EBPG.filler, root.EBPG.panel);
  if (isNode) module.exports = api;
  else if (!root.__ebpgSiteStarted && root.chrome && root.chrome.runtime && root.chrome.runtime.id) {
    root.__ebpgSiteStarted = true;
    api.createSiteHelper({ win: root, doc: root.document, runtime: root.chrome.runtime, storage: root.chrome.storage && root.chrome.storage.local }).start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared, filler, panelLib) {
  'use strict';

  const ROW_FOR_KIND = {
    title: 'title', date: 'date', endDate: 'date', datetime: 'date', endDatetime: 'date',
    start: 'time', end: 'time', location: 'place', address: 'place', description: 'description', body: 'text'
  };

  function createSiteHelper(opts) {
    const { win, doc, runtime, storage } = opts;
    const now = opts.now || (() => Date.now());
    const watchMs = opts.watchMs || 20000;
    const debounceMs = opts.debounceMs || 300;
    const channel = shared.channelForHost(win.location.hostname);

    let draft = null, panel = null, observer = null, debounce = null, stopTimer = null;
    let filledEls = new WeakSet(), filledKinds = new Set(), imageAttached = false;
    // used: this tab already had the event filled on an earlier page, so wait for Fill again.
    let used = false, reported = false;
    const userEls = new WeakSet();
    const memory = new WeakMap();

    function send(msg) {
      try { return Promise.resolve(runtime.sendMessage(msg)).catch(() => null); } catch (e) { return Promise.resolve(null); }
    }

    function isCreatePage() {
      return /\/(create|new|edit|manage|schedule)(\/|$)/i.test(win.location.pathname) || /create|new/i.test(win.location.hash || '');
    }

    function rowsFilled() {
      const keys = new Set(shared.copyRows(draft).map(r => r.key));
      const out = new Set();
      filledKinds.forEach(kind => {
        let row = ROW_FOR_KIND[kind];
        if (row === 'description' && !keys.has('description')) row = 'text';
        if (row === 'text' && !keys.has('text')) row = 'description';
        out.add(row);
      });
      return out;
    }

    function render(looking) {
      if (!draft) return;
      if (!panel) panel = panelLib.createPanel(doc, { onFillAgain: fillAgain, onDismiss: dismiss });
      panel.render({ draft, count: filledKinds.size + (imageAttached ? 1 : 0), filled: rowsFilled(), imageAttached, looking: !!looking, used });
    }

    function pass(force) {
      if (!draft) return null;
      const res = filler.fill(doc, draft, {
        channel,
        createPage: isCreatePage(),
        force: !!force,
        skip: force ? null : el => filledEls.has(el) || userEls.has(el),
        withImage: !imageAttached,
        memory
      });
      res.filled.forEach(({ kind, el }) => { filledKinds.add(kind); filledEls.add(el); });
      if (res.image === 'attached') imageAttached = true;
      if (res.mode && res.filled.length && !reported) {
        reported = true;
        send({ type: 'used' });
      }
      render(!res.mode && !!observer);
      return res;
    }

    function stopWatching() {
      if (observer) observer.disconnect();
      observer = null;
      if (debounce) win.clearTimeout(debounce);
      if (stopTimer) win.clearTimeout(stopTimer);
      debounce = stopTimer = null;
      render(false);
    }

    // Single-page apps draw the form late or swap it out; look again when the page changes.
    function watch() {
      if (observer) observer.disconnect();
      if (stopTimer) win.clearTimeout(stopTimer);
      observer = new win.MutationObserver(() => {
        if (debounce) return;
        debounce = win.setTimeout(() => { debounce = null; if (observer) pass(false); }, debounceMs);
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      stopTimer = win.setTimeout(stopWatching, watchMs);
    }

    function fillAgain() {
      used = false;
      filledEls = new WeakSet();
      filledKinds = new Set();
      watch();
      return pass(true);
    }

    function dismiss() {
      if (observer) observer.disconnect();
      observer = null;
      if (stopTimer) win.clearTimeout(stopTimer);
      if (panel) panel.destroy();
      panel = null;
      draft = null;
      send({ type: 'disarm' });
    }

    async function claim() {
      const r = await send({ type: 'claim', channel });
      return r && r.draft ? r : null;
    }

    // Cheap check before talking to the service worker: is there a fresh event at all?
    async function hasFreshDraft() {
      if (!storage || typeof storage.get !== 'function') return true;
      try {
        const r = await storage.get('draft');
        return shared.isFresh(r && r.draft, now());
      } catch (e) {
        return false;
      }
    }

    function listenForTyping() {
      // Same function and options each time, so the browser adds it only once.
      doc.addEventListener('input', onUserInput, true);
    }

    function onUserInput(e) {
      if (!e.isTrusted || !e.target || e.target.nodeType !== 1) return;
      let el = e.target;
      for (let p = el; p; p = p.parentElement) if (p.hasAttribute && p.hasAttribute('contenteditable')) el = p;
      userEls.add(el);
    }

    function onRuntimeMessage(msg, sender, sendResponse) {
      if (!msg || (sender && sender.id && runtime.id && sender.id !== runtime.id)) return false;
      if (msg.type === 'ebpg-hello') { sendResponse({ channel }); return false; }
      if (msg.type === 'ebpg-fill-now') {
        claim().then(c => {
          if (!c) return sendResponse({ ok: false });
          draft = c.draft;
          listenForTyping();
          // Fill this tab armed the tab again, so this fill counts as its first one.
          reported = false;
          const res = fillAgain();
          sendResponse({ ok: true, count: filledKinds.size + (imageAttached ? 1 : 0), mode: res && res.mode });
        });
        return true;
      }
      return false;
    }

    async function start() {
      if (!channel) return;
      // Always listen, so Fill this tab works even when nothing was sent to this tab.
      if (runtime.onMessage) runtime.onMessage.addListener(onRuntimeMessage);
      if (!(await hasFreshDraft())) return;
      listenForTyping();
      const c = await claim();
      if (!c) return;
      draft = c.draft;
      if (c.used) {
        // Filled once already in this tab: show the fields, fill only when asked.
        used = true;
        render(false);
        return;
      }
      watch();
      pass(false);
    }

    return { start, pass, fillAgain, dismiss, stopWatching, onRuntimeMessage, get state() { return { channel, draft, filledKinds, imageAttached, watching: !!observer, panel, used }; } };
  }

  return { createSiteHelper, ROW_FOR_KIND };
});
