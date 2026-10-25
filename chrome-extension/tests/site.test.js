'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSiteHelper } = require('../src/site.js');
const { createPanel } = require('../src/panel.js');
const H = require('./helpers.js');

// A stand-in for the service worker's side: claim answers with the draft (and whether this
// tab already had one fill), 'used' marks the tab, like background.js does.
function runtimeWith(draft, o) {
  const sent = [];
  const listeners = [];
  const rt = {
    sent, listeners,
    used: !!(o && o.used),
    id: 'ext',
    sendMessage: async msg => {
      sent.push(msg);
      if (msg.type === 'claim') return draft ? { draft, channel: 'partiful', used: rt.used } : { draft: null };
      if (msg.type === 'used') rt.used = true;
      return { ok: true };
    },
    onMessage: { addListener: fn => listeners.push(fn) }
  };
  return rt;
}

// chrome.storage.local as the content script sees it: by default it holds the draft, sent just now.
function page(html, url, draft, opts) {
  const o = Object.assign({}, opts || {});
  const d = H.dom(html, url);
  const win = d.window;
  const runtime = runtimeWith(draft, o);
  const storage = 'storage' in o ? o.storage : H.storageArea(draft ? { draft: { channel: 'partiful', timestamp: Date.now(), draft } } : {});
  delete o.storage; delete o.used;
  const helper = createSiteHelper(Object.assign({ win, doc: win.document, runtime, storage, watchMs: 400, debounceMs: 10 }, o));
  return { win, doc: win.document, runtime, storage, helper };
}

const panelText = helper => helper.state.panel.shadow.querySelector('.msg').textContent;

test('fills the opened Partiful tab and shows the panel with a Copy button per field', async () => {
  const p = page(H.fixture('partiful-create.html'), 'https://partiful.com/create', H.draft());
  const submits = H.watchSubmits(p.doc);
  await p.helper.start();
  assert.deepEqual(p.runtime.sent[0], { type: 'claim', channel: 'partiful' });
  assert.equal(p.doc.querySelector('textarea.title').value, H.draft().title);
  const host = p.doc.querySelector('ebpg-posting-helper');
  assert.ok(host, 'panel is on the page');
  assert.match(panelText(p.helper), /^EBPG Posting Helper filled 3 fields\. Review everything, then publish\./);
  const shadow = p.helper.state.panel.shadow;
  const labels = [...shadow.querySelectorAll('li .lab')].map(l => l.firstChild.textContent);
  assert.deepEqual(labels, ['Title', 'Date', 'Time', 'Place', 'Description', 'Full text', 'Event link']);
  const copyButtons = [...shadow.querySelectorAll('button[data-copy]')];
  assert.equal(copyButtons.length, 7);
  assert.equal(copyButtons[0].getAttribute('aria-label'), 'Copy title');
  const tags = [...shadow.querySelectorAll('li .tag')].map(t => t.textContent);
  assert.deepEqual(tags, ['Filled', 'Copy and paste', 'Copy and paste', 'Filled', 'Filled', 'Copy and paste', 'Copy and paste']);
  assert.ok(shadow.querySelector('[data-act="fill"]'));
  assert.ok(shadow.querySelector('[data-act="dismiss"]'));
  assert.deepEqual(submits, []);
  p.helper.stopWatching();
});

test('event text is shown as text, never as HTML', async () => {
  const evil = H.draft({ title: '<img src=x onerror="window.hacked=1">Workday' });
  const p = page(H.fixture('partiful-create.html'), 'https://partiful.com/create', evil);
  await p.helper.start();
  const shadow = p.helper.state.panel.shadow;
  assert.equal(shadow.querySelector('img[onerror]'), null);
  assert.equal(shadow.querySelector('li .val').textContent, evil.title);
  p.helper.stopWatching();
});

test('does nothing at all when this tab was not opened for a draft', async () => {
  const p = page(H.fixture('partiful-create.html'), 'https://partiful.com/create', null);
  await p.helper.start();
  assert.equal(p.doc.querySelector('ebpg-posting-helper'), null);
  assert.equal(p.doc.querySelector('textarea.title').value, '');
});

test('does nothing on sites that are not supported', async () => {
  const p = page('<input placeholder="Event name">', 'https://example.org/create', H.draft());
  await p.helper.start();
  assert.deepEqual(p.runtime.sent, []);
});

test('fills a form that appears later (single-page app), then stops watching', async () => {
  const p = page('<main id="app"><p>Loading…</p></main>', 'https://www.meetup.com/x/events/create/', H.draft());
  await p.helper.start();
  assert.match(panelText(p.helper), /looking for the form/);
  p.doc.getElementById('app').innerHTML = '<form><label for=t>Title</label><input id=t><label for=d>Description</label><textarea id=d></textarea></form>';
  await H.tick(60);
  assert.equal(p.doc.getElementById('t').value, H.draft().title);
  assert.equal(p.doc.getElementById('d').value, H.draft().description);
  assert.match(panelText(p.helper), /filled 2 fields/);
  await H.tick(450);
  assert.equal(p.helper.state.watching, false, 'gave up watching after the time limit');
  p.doc.body.insertAdjacentHTML('beforeend', '<label for=w>Location</label><input id=w>');
  await H.tick(40);
  assert.equal(p.doc.getElementById('w').value, '', 'nothing more happens after it stops');
});

test('says it could not find the form when nothing matches after watching', async () => {
  const p = page('<main><p>Pick a template</p></main>', 'https://partiful.com/create', H.draft(), { watchMs: 30 });
  await p.helper.start();
  await H.tick(60);
  assert.match(panelText(p.helper), /couldn.t find the form/);
  assert.equal(p.helper.state.panel.shadow.querySelectorAll('button[data-copy]').length, 7, 'copy buttons are the fallback');
});

test('Fill again overwrites changed fields; Dismiss removes the panel and tells the service worker', async () => {
  const p = page(H.fixture('meetup-create.html'), 'https://www.meetup.com/x/events/create/', H.draft());
  await p.helper.start();
  const title = p.doc.getElementById('title');
  title.value = 'Changed by hand';
  const shadow = p.helper.state.panel.shadow;
  shadow.querySelector('[data-act="fill"]').dispatchEvent(new p.win.MouseEvent('click', { bubbles: true }));
  assert.equal(title.value, H.draft().title);
  shadow.querySelector('[data-act="dismiss"]').dispatchEvent(new p.win.MouseEvent('click', { bubbles: true }));
  assert.equal(p.doc.querySelector('ebpg-posting-helper'), null);
  await H.tick(5);
  assert.deepEqual(p.runtime.sent.map(m => m.type), ['claim', 'used', 'disarm']);
});

test('the Copy button copies that field and says so for screen readers', async () => {
  const p = page(H.fixture('meetup-create.html'), 'https://www.meetup.com/x/events/create/', H.draft());
  const copied = [];
  Object.defineProperty(p.win.navigator, 'clipboard', { configurable: true, value: { writeText: async t => { copied.push(t); } } });
  await p.helper.start();
  const shadow = p.helper.state.panel.shadow;
  const btn = shadow.querySelector('button[data-copy="time"]');
  btn.dispatchEvent(new p.win.MouseEvent('click', { bubbles: true }));
  await H.tick(50);
  assert.deepEqual(copied, ['10:00 AM to 1:00 PM']);
  assert.equal(btn.textContent, 'Copied');
  assert.equal(shadow.querySelector('.sr').textContent, 'Time copied.');
  p.helper.stopWatching();
});

test('the popup or side panel can ask an already-open tab to fill now', async () => {
  const p = page(H.fixture('hylo-event.html'), 'https://www.hylo.com/groups/ebpg/create/post', H.draft());
  await p.helper.start();
  p.helper.dismiss();
  const listener = p.runtime.listeners[0];
  let hello;
  listener({ type: 'ebpg-hello' }, { id: 'ext' }, r => { hello = r; });
  assert.deepEqual(hello, { channel: 'hylo' });
  p.doc.querySelector('input[name=title]').value = '';
  let answer;
  assert.equal(listener({ type: 'ebpg-fill-now' }, { id: 'ext' }, r => { answer = r; }), true);
  for (let i = 0; i < 20 && !answer; i++) await H.tick(5);
  assert.equal(answer.ok, true);
  assert.equal(answer.count, 5);
  assert.equal(p.doc.querySelector('input[name=title]').value, H.draft().title);
  p.helper.stopWatching();
});

test('panel shows the image with a Download link named after the event', () => {
  const d = H.dom('<body></body>', 'https://partiful.com/create');
  const win = d.window;
  win.URL.createObjectURL = () => 'blob:https://partiful.com/1234';
  win.URL.revokeObjectURL = () => {};
  const panel = createPanel(win.document, {});
  panel.render({ draft: H.draft({ imageDataUrl: H.TINY_PNG }), count: 1, filled: new Set(['title']), imageAttached: false });
  const a = panel.shadow.querySelector('.img a');
  assert.equal(panel.shadow.querySelector('.img').hidden, false);
  assert.equal(a.getAttribute('href'), 'blob:https://partiful.com/1234');
  assert.equal(a.getAttribute('download'), 'workday-7-sheet-mulching-the-food-forest.png');
  assert.match(panel.shadow.querySelector('.msg').textContent, /filled 1 field\./);
  const collapse = panel.shadow.querySelector('[data-act="collapse"]');
  collapse.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.equal(collapse.getAttribute('aria-expanded'), 'false');
  assert.equal(collapse.getAttribute('aria-label'), 'Show the field list');
  panel.destroy();
  assert.equal(win.document.querySelector('ebpg-posting-helper'), null);
});

test('the panel keeps keyboard focus when the page changes but the fill result does not', async () => {
  const p = page(H.fixture('meetup-create.html'), 'https://www.meetup.com/x/events/create/', H.draft());
  await p.helper.start();
  const shadow = p.helper.state.panel.shadow;
  const before = shadow.querySelector('button[data-copy="title"]');
  p.doc.body.appendChild(p.doc.createElement('div'));
  await H.tick(40);
  assert.equal(shadow.querySelector('button[data-copy="title"]'), before, 'rows were not rebuilt');
  p.helper.stopWatching();
});

test('a tab fills by itself only once; the next page in it waits for Fill again', async () => {
  const first = page(H.fixture('partiful-create.html'), 'https://partiful.com/create', H.draft());
  await first.helper.start();
  first.helper.stopWatching();
  assert.equal(first.doc.querySelector('textarea.title').value, H.draft().title);
  assert.deepEqual(first.runtime.sent.map(m => m.type), ['claim', 'used'], 'the service worker hears about the first fill once');

  // A later full page load in the same tab, for example a new create form after publishing.
  const next = page(H.fixture('partiful-create.html'), 'https://partiful.com/create', H.draft(), { used: true });
  await next.helper.start();
  assert.equal(next.doc.querySelector('textarea.title').value, '', 'not filled again on its own');
  assert.equal(next.helper.state.watching, false);
  assert.match(panelText(next.helper), /already filled this event in this tab/);
  assert.match(panelText(next.helper), /Click Fill again to fill this page/);
  const shadow = next.helper.state.panel.shadow;
  assert.equal(shadow.querySelectorAll('button[data-copy]').length, 7, 'Copy buttons are still there');
  shadow.querySelector('[data-act="fill"]').dispatchEvent(new next.win.MouseEvent('click', { bubbles: true }));
  assert.equal(next.doc.querySelector('textarea.title').value, H.draft().title, 'Fill again fills it');
  assert.match(panelText(next.helper), /filled 3 fields/);
  next.helper.stopWatching();
});

test('a page that matches nothing does not use up the tab\'s one fill', async () => {
  const p = page(H.fixture('partiful-login.html'), 'https://partiful.com/login', H.draft(), { watchMs: 30 });
  await p.helper.start();
  await H.tick(60);
  assert.deepEqual(p.runtime.sent.map(m => m.type), ['claim'], 'sign-in page: still armed for the form after it');
});

test('with no fresh event saved, it does nothing on the page and does not wake the service worker', async () => {
  for (const storage of [H.storageArea(), H.storageArea({ draft: { channel: 'partiful', timestamp: Date.now() - 31 * 60 * 1000, draft: H.draft() } })]) {
    const p = page(H.fixture('partiful-create.html'), 'https://partiful.com/create', H.draft(), { storage });
    const added = [];
    const add = p.doc.addEventListener.bind(p.doc);
    p.doc.addEventListener = (type, fn, opt) => { added.push(type); return add(type, fn, opt); };
    await p.helper.start();
    assert.deepEqual(p.runtime.sent, [], 'no claim sent');
    assert.deepEqual(added, [], 'no page listeners added');
    assert.equal(p.doc.querySelector('ebpg-posting-helper'), null);
    assert.equal(p.runtime.listeners.length, 1, 'Fill this tab can still reach it');
  }
});

test('Fill this tab still works in a tab that started with nothing saved', async () => {
  const p = page(H.fixture('meetup-create.html'), 'https://www.meetup.com/x/events/create/', H.draft(), { storage: H.storageArea() });
  await p.helper.start();
  assert.deepEqual(p.runtime.sent, []);
  let answer;
  p.runtime.listeners[0]({ type: 'ebpg-fill-now' }, { id: 'ext' }, r => { answer = r; });
  for (let i = 0; i < 20 && !answer; i++) await H.tick(5);
  assert.equal(answer.ok, true);
  assert.equal(p.doc.getElementById('title').value, H.draft().title);
  assert.deepEqual(p.runtime.sent.map(m => m.type), ['claim', 'used']);
  p.helper.stopWatching();
});

test('when the site blocks copying, the whole value is shown selected for Ctrl or Command C', async () => {
  const p = page(H.fixture('meetup-create.html'), 'https://www.meetup.com/x/events/create/', H.draft());
  Object.defineProperty(p.win.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('NotAllowedError'); } } });
  p.doc.execCommand = () => false;
  await p.helper.start();
  const shadow = p.helper.state.panel.shadow;
  const btn = shadow.querySelector('button[data-copy="text"]');
  btn.dispatchEvent(new p.win.MouseEvent('click', { bubbles: true }));
  await H.tick(50);
  const ta = btn.closest('li').querySelector('.manual textarea');
  assert.ok(ta, 'a box with the full text appears in that row');
  assert.equal(ta.value, H.draft().text, 'the full value, not the 2-line preview');
  assert.equal(ta.readOnly, true);
  assert.equal(shadow.activeElement, ta, 'keyboard focus moves to it');
  assert.equal(ta.selectionStart, 0);
  assert.equal(ta.selectionEnd, H.draft().text.length);
  assert.match(ta.getAttribute('aria-label'), /^Full text, selected\. Press (Ctrl|Command) C to copy it\.$/);
  assert.match(btn.closest('li').querySelector('.manual .hint').textContent, /Copying was blocked/);
  assert.match(shadow.querySelector('.sr').textContent, /Could not copy the full text\. It is selected in a box below/);
  btn.dispatchEvent(new p.win.MouseEvent('click', { bubbles: true }));
  await H.tick(20);
  assert.equal(btn.closest('li').querySelectorAll('.manual').length, 1, 'a second try reuses the same box');
  p.helper.stopWatching();
});
