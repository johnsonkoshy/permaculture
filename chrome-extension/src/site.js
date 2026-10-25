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
    ? factory(require('./shared.js'), require('./filler.js'), require('./panel.js'), require('./partiful.js'))
    : factory(root.EBPG.shared, root.EBPG.filler, root.EBPG.panel, root.EBPG.partiful);
  if (isNode) module.exports = api;
  else if (!root.__ebpgSiteStarted && root.chrome && root.chrome.runtime && root.chrome.runtime.id) {
    root.__ebpgSiteStarted = true;
    api.createSiteHelper({ win: root, doc: root.document, runtime: root.chrome.runtime, storage: root.chrome.storage && root.chrome.storage.local }).start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared, filler, panelLib, partiful) {
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
    // Partiful's page is filled step by step (see partiful.js): the run in progress, and whether one finished.
    let partifulRun = null, partifulDone = false;
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

    // What a fill found: remember what got filled, tell the service worker once, update the panel.
    function apply(res) {
      res.filled.forEach(({ kind, el }) => { filledKinds.add(kind); filledEls.add(el); });
      if (res.image === 'attached') imageAttached = true;
      if (res.mode && res.filled.length && !reported) {
        reported = true;
        send({ type: 'used' });
      }
      render(!res.mode && !!observer);
      return res;
    }

    // Partiful: one run at a time. The page changes all through a run, and those changes start no
    // second one; after a run, only Fill again starts another. Fill again during a run goes next.
    function passPartiful(force) {
      if (partifulRun) {
        if (!force) return partifulRun;
        const next = partifulRun.then(() => { partifulRun = null; return passPartiful(true); });
        partifulRun = next;
        return next;
      }
      if (partifulDone && !force) return null;
      // Another event in the editor (the person kept editing their own): only Fill again fills it.
      if (!force && partiful.holdsOther(doc, draft)) {
        partifulDone = true;
        render(false);
        return null;
      }
      render(true);
      const forDraft = draft;
      const run = partiful.fill(doc, draft, {
        force: !!force,
        skipKind: force ? null : kind => filledKinds.has(kind),
        withImage: !imageAttached,
        // Closing the panel (dismiss) stops the run.
        halted: () => draft !== forDraft,
        timing: opts.partifulTiming
      }).catch(() => ({ mode: null, filled: [], failed: [], kept: [], image: 'none' })).then(res => {
        // A Fill again queued behind this run has taken its place; leave that one in.
        if (partifulRun === run) partifulRun = null;
        partifulDone = true;
        return draft ? apply(res) : res;
      });
      partifulRun = run;
      return run;
    }

    function pass(force) {
      if (!draft) return null;
      if (channel === 'partiful' && partiful) {
        if (partifulRun || partiful.isEditor(doc)) return passPartiful(force);
        // Partiful's "unsaved event" question: the editor shows once it's answered, and the watcher fills it.
        if (partiful.resumePrompt(doc)) {
          partiful.resumeOwn(doc, draft);
          render(true);
          return null;
        }
      }
      const res = filler.fill(doc, draft, {
        channel,
        createPage: isCreatePage(),
        force: !!force,
        skip: force ? null : el => filledEls.has(el) || userEls.has(el),
        withImage: !imageAttached,
        memory
      });
      return apply(res);
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
      stopTimer = win.setTimeout(expire, watchMs);
    }

    // Stop watching after watchMs, except while Partiful waits for the person to answer its
    // "unsaved event" question: the form shows only after that.
    function expire() {
      if (channel === 'partiful' && partiful && partiful.resumePrompt(doc)) {
        stopTimer = win.setTimeout(expire, watchMs);
        return;
      }
      stopWatching();
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
          Promise.resolve(fillAgain()).then(res => {
            sendResponse({ ok: true, count: filledKinds.size + (imageAttached ? 1 : 0), mode: res && res.mode });
          });
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
