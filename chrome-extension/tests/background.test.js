'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackground } = require('../src/background.js');
const H = require('./helpers.js');

const EXT = 'chrome-extension://abcdefghijklmnop/';
const HUB_TAB = { id: 7, index: 2, windowId: 1, url: 'http://localhost:8766/site/' };

function fakeChrome(opts) {
  const o = opts || {};
  const calls = { tabs: [], options: 0, sidePanel: [], sent: [] };
  let nextTab = 100;
  const listeners = { message: [], removed: [], installed: [] };
  const chrome = {
    runtime: {
      id: 'abcdefghijklmnop',
      getURL: p => EXT + p,
      openOptionsPage: async () => { calls.options++; },
      onMessage: { addListener: fn => listeners.message.push(fn) },
      onInstalled: { addListener: fn => listeners.installed.push(fn) }
    },
    tabs: {
      create: async props => { calls.tabs.push(props); return { id: nextTab++, index: (props.index || 0), windowId: 1 }; },
      sendMessage: async (tabId, msg) => {
        calls.sent.push({ tabId, msg });
        if (o.tabAnswers) return o.tabAnswers(tabId, msg);
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      onRemoved: { addListener: fn => listeners.removed.push(fn) }
    },
    sidePanel: {
      open: o.sidePanelFails
        ? () => { throw new Error('sidePanel.open() may only be called in response to a user gesture.'); }
        : async args => { calls.sidePanel.push(args); }
    },
    storage: { local: H.storageArea(o.local), sync: H.storageArea(o.sync), session: H.storageArea() }
  };
  return { chrome, calls, listeners };
}

const hubSender = { id: 'abcdefghijklmnop', tab: HUB_TAB, url: HUB_TAB.url, origin: 'http://localhost:8766' };
const pageSender = { id: 'abcdefghijklmnop', url: EXT + 'pages/sidepanel.html' };
const siteSender = (tabId, url) => ({ id: 'abcdefghijklmnop', tab: { id: tabId, index: 3, windowId: 1 }, url, origin: new URL(url).origin });
const record = (t, extra) => Object.assign({ channel: 'partiful', timestamp: t, origin: 'http://localhost:8766', draft: H.draft() }, extra || {});

test('Partiful and Luma open their create pages next to the hub tab', async () => {
  const { chrome, calls } = fakeChrome();
  const bg = createBackground(chrome, { now: () => 1000 });
  let res = await bg.handle({ type: 'open', channel: 'partiful' }, hubSender);
  assert.deepEqual(res, { ok: true, channel: 'partiful', tabId: 100 });
  assert.deepEqual(calls.tabs[0], { url: 'https://partiful.com/create', active: true, openerTabId: 7, index: 3 });
  res = await bg.handle({ type: 'open', channel: 'luma' }, hubSender);
  assert.equal(calls.tabs[1].url, 'https://lu.ma/create');
  const armed = chrome.storage.session.data.armed;
  assert.deepEqual(armed[100], { channel: 'partiful', at: 1000 });
  assert.deepEqual(armed[101], { channel: 'luma', at: 1000 });
});

test('Meetup, Facebook and Hylo use the group links from Options', async () => {
  const { chrome, calls } = fakeChrome({ sync: {
    meetupUrl: 'https://www.meetup.com/east-bay-permaculture/events/create/',
    facebookUrl: 'facebook.com/groups/ebpg',
    hyloUrl: 'https://www.hylo.com/groups/ebpg'
  } });
  const bg = createBackground(chrome);
  for (const ch of ['meetup', 'facebook', 'hylo']) assert.equal((await bg.handle({ type: 'open', channel: ch }, hubSender)).ok, true);
  assert.deepEqual(calls.tabs.map(t => t.url), [
    'https://www.meetup.com/east-bay-permaculture/events/create/',
    'https://facebook.com/groups/ebpg',
    'https://www.hylo.com/groups/ebpg'
  ]);
});

test('a missing (or off-site) group link opens Options with a note and tells the hub why', async () => {
  const { chrome, calls } = fakeChrome({ sync: { facebookUrl: 'https://evil.example/groups/ebpg' } });
  const bg = createBackground(chrome, { now: () => 5 });
  const res = await bg.handle({ type: 'open', channel: 'facebook' }, hubSender);
  assert.equal(res.ok, false);
  assert.match(res.error, /Facebook group link/);
  assert.equal(calls.options, 1);
  assert.deepEqual(chrome.storage.local.data.notice, { channel: 'facebook', at: 5 });
  assert.deepEqual(calls.tabs, []);
});

test('Instagram opens the side panel in the hub window, or a tab if Chrome refuses', async () => {
  let f = fakeChrome();
  let res = await createBackground(f.chrome).handle({ type: 'open', channel: 'instagram' }, hubSender);
  assert.deepEqual(res, { ok: true, channel: 'instagram', where: 'side-panel' });
  assert.deepEqual(f.calls.sidePanel, [{ windowId: 1 }]);
  f = fakeChrome({ sidePanelFails: true });
  res = await createBackground(f.chrome).handle({ type: 'open', channel: 'instagram' }, hubSender);
  assert.equal(res.where, 'tab');
  assert.equal(f.calls.tabs[0].url, EXT + 'pages/sidepanel.html?view=tab');
});

test('only the hub may ask to open a site', async () => {
  const { chrome, calls } = fakeChrome();
  const bg = createBackground(chrome);
  const fromFacebook = siteSender(5, 'https://www.facebook.com/');
  assert.equal((await bg.handle({ type: 'open', channel: 'partiful' }, fromFacebook)).ok, false);
  assert.equal((await bg.handle({ type: 'open', channel: 'partiful' }, Object.assign({}, hubSender, { id: 'other-extension' }))).ok, false);
  assert.equal((await bg.handle({ type: 'open', channel: 'myspace' }, hubSender)).ok, false);
  assert.deepEqual(calls.tabs, []);
});

test('the draft goes only to the tab that was opened for it, on the right site, while fresh', async () => {
  let now = 1000;
  const { chrome } = fakeChrome({ local: { draft: record(1000) } });
  const bg = createBackground(chrome, { now: () => now });
  await bg.handle({ type: 'open', channel: 'partiful' }, hubSender);
  const ok = await bg.handle({ type: 'claim' }, siteSender(100, 'https://partiful.com/create'));
  assert.equal(ok.draft.title, H.draft().title);
  assert.equal(ok.channel, 'partiful');
  assert.equal((await bg.handle({ type: 'claim' }, siteSender(55, 'https://partiful.com/create'))).draft, null, 'another tab');
  assert.equal((await bg.handle({ type: 'claim' }, siteSender(100, 'https://www.facebook.com/'))).draft, null, 'tab moved to another site');
  now = 1000 + 31 * 60 * 1000;
  assert.equal((await bg.handle({ type: 'claim' }, siteSender(100, 'https://partiful.com/create'))).draft, null, 'too old');
});

test('a claim made while the tab is still being opened waits for it', async () => {
  const { chrome } = fakeChrome({ local: { draft: record(1000, { channel: 'luma' }) } });
  const bg = createBackground(chrome, { now: () => 1000 });
  const opening = bg.handle({ type: 'open', channel: 'luma' }, hubSender);
  const claim = bg.handle({ type: 'claim' }, siteSender(100, 'https://luma.com/create'));
  await opening;
  assert.equal((await claim).channel, 'luma');
});

test('Dismiss and closing the tab both forget the tab', async () => {
  const { chrome, listeners } = fakeChrome({ local: { draft: record(0) } });
  const bg = createBackground(chrome, { now: () => 0 });
  bg.register();
  await bg.handle({ type: 'open', channel: 'partiful' }, hubSender);
  await bg.handle({ type: 'open', channel: 'luma' }, hubSender);
  await bg.handle({ type: 'disarm' }, siteSender(100, 'https://partiful.com/create'));
  assert.equal(100 in chrome.storage.session.data.armed, false);
  listeners.removed[0](101);
  await H.tick(5);
  assert.deepEqual(chrome.storage.session.data.armed, {});
});

test('the side panel can open a site again, which keeps an older draft usable', async () => {
  let now = 0;
  const { chrome, calls } = fakeChrome({ local: { draft: record(0) } });
  const bg = createBackground(chrome, { now: () => now });
  now = 60 * 60 * 1000;
  const res = await bg.handle({ type: 'open-target', channel: 'luma' }, pageSender);
  assert.equal(res.ok, true);
  assert.equal(calls.tabs[0].url, 'https://lu.ma/create');
  assert.equal(chrome.storage.local.data.draft.openedAt, now);
  assert.equal(chrome.storage.local.data.draft.openedFor, 'luma');
  assert.ok((await bg.handle({ type: 'claim' }, siteSender(100, 'https://luma.com/create'))).draft);
  // Content scripts cannot use the page-only requests.
  assert.equal((await bg.handle({ type: 'open-target', channel: 'luma' }, siteSender(3, 'https://www.facebook.com/'))).ok, false);
});

test('the side panel says so when there is no event yet', async () => {
  const { chrome, calls } = fakeChrome();
  const res = await createBackground(chrome).handle({ type: 'open-target', channel: 'partiful' }, pageSender);
  assert.equal(res.ok, false);
  assert.match(res.error, /No event yet/);
  assert.deepEqual(calls.tabs, []);
});

test('"Fill this tab" arms the current tab and asks its content script to fill', async () => {
  const { chrome, calls } = fakeChrome({
    local: { draft: record(0) },
    tabAnswers: (tabId, msg) => msg.type === 'ebpg-hello' ? { channel: 'meetup' } : { ok: true, count: 5 }
  });
  const bg = createBackground(chrome, { now: () => 10 });
  const res = await bg.handle({ type: 'fill-tab', tabId: 42 }, pageSender);
  assert.deepEqual(res, { ok: true, channel: 'meetup', count: 5 });
  assert.deepEqual(calls.sent.map(s => s.msg.type), ['ebpg-hello', 'ebpg-fill-now']);
  assert.deepEqual(chrome.storage.session.data.armed[42], { channel: 'meetup', at: 10 });
});

test('"Fill this tab" on a site the helper does not cover explains why', async () => {
  const { chrome } = fakeChrome({ local: { draft: record(0) } });
  const res = await createBackground(chrome).handle({ type: 'fill-tab', tabId: 42 }, pageSender);
  assert.equal(res.ok, false);
  assert.match(res.error, /Partiful, Luma, Meetup, Facebook or Hylo/);
});

test('register() answers messages asynchronously and opens Options on first install', async () => {
  const { chrome, listeners, calls } = fakeChrome();
  createBackground(chrome).register();
  let answer;
  const keepOpen = listeners.message[0]({ type: 'open', channel: 'partiful' }, hubSender, r => { answer = r; });
  assert.equal(keepOpen, true);
  for (let i = 0; i < 20 && !answer; i++) await H.tick(2);
  assert.equal(answer.ok, true);
  listeners.installed[0]({ reason: 'install' });
  listeners.installed[0]({ reason: 'update' });
  assert.equal(calls.options, 1);
});

test('after the first fill in a tab, later claims there say "used" until the tab is armed again', async () => {
  const { chrome } = fakeChrome({
    local: { draft: record(0) },
    tabAnswers: (tabId, msg) => msg.type === 'ebpg-hello' ? { channel: 'partiful' } : { ok: true, count: 3 }
  });
  const bg = createBackground(chrome, { now: () => 0 });
  await bg.handle({ type: 'open', channel: 'partiful' }, hubSender);
  const site = siteSender(100, 'https://partiful.com/create');
  assert.equal((await bg.handle({ type: 'claim' }, site)).used, false);
  assert.deepEqual(await bg.handle({ type: 'used' }, site), { ok: true });
  const later = await bg.handle({ type: 'claim' }, site);
  assert.equal(later.draft.title, H.draft().title, 'the panel still gets the event');
  assert.equal(later.used, true, 'but it is not filled on its own');
  // Another tab, or the same tab on another site, cannot mark it.
  assert.deepEqual(await bg.handle({ type: 'used' }, siteSender(55, 'https://partiful.com/create')), { ok: false });
  assert.deepEqual(await bg.handle({ type: 'used' }, siteSender(101, 'https://www.facebook.com/')), { ok: false });
  // Fill this tab arms it afresh.
  await bg.handle({ type: 'fill-tab', tabId: 100 }, pageSender);
  assert.equal((await bg.handle({ type: 'claim' }, site)).used, false);
});
