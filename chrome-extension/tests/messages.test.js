'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../src/shared.js');
const { createHubBridge } = require('../src/hub-bridge.js');
const H = require('./helpers.js');

const HUB = 'http://localhost:8766';

function hub(opts) {
  const o = opts || {};
  const d = H.dom('<!doctype html><html><head></head><body></body></html>', o.url || HUB + '/site/');
  const win = d.window;
  const replies = [];
  win.postMessage = (msg, origin) => { replies.push({ msg, origin }); };
  const storage = H.storageArea();
  const realSet = storage.set;
  storage.set = async obj => {
    // Chrome refuses a write that does not fit; with the image is the usual case.
    if (o.storageFails || (o.storageFailsWithImage && obj.draft && obj.draft.draft.imageDataUrl)) throw new Error('QUOTA_BYTES quota exceeded');
    return realSet(obj);
  };
  const sent = [];
  const runtime = {
    id: o.noRuntime ? undefined : 'ext-id',
    sendMessage: async msg => { sent.push(msg); if (o.slowOpen) await H.tick(o.slowOpen); return o.answer || { ok: true, channel: msg.channel }; }
  };
  let t = 1_000_000;
  const bridge = createHubBridge({ win, doc: win.document, runtime, storage, version: '1.0.0', now: () => t });
  bridge.start();
  const fill = (data, extra) => bridge.onMessage(Object.assign({ source: win, origin: new URL(o.url || HUB).origin, data }, extra || {}));
  return { win, replies, storage, sent, bridge, fill, advance: ms => { t += ms; } };
}

const msg = (channel, draft) => ({ source: 'ebpg-hub', type: 'fill', channel, draft: draft || H.draft() });

test('marks the hub page with the helper version as soon as it loads', () => {
  const { win } = hub();
  assert.equal(win.document.documentElement.dataset.ebpgPoster, '1.0.0');
  assert.equal(win.document.documentElement.getAttribute('data-ebpg-poster'), '1.0.0');
});

test('a valid fill request is saved and the site opened; the page hears "opened"', async () => {
  const h = hub();
  await h.fill(msg('partiful'));
  const rec = h.storage.data.draft;
  assert.equal(rec.channel, 'partiful');
  assert.equal(rec.timestamp, 1_000_000);
  assert.equal(rec.origin, HUB);
  assert.equal(rec.draft.title, H.draft().title);
  assert.deepEqual(h.sent, [{ type: 'open', channel: 'partiful' }]);
  assert.deepEqual(h.replies, [{ msg: { source: 'ebpg-poster', type: 'opened', channel: 'partiful' }, origin: HUB }]);
});

test('messages from another window, another origin or another sender are ignored silently', async () => {
  const h = hub();
  await h.fill(msg('luma'), { source: {} });
  await h.fill(msg('luma'), { origin: 'https://evil.example' });
  await h.fill({ source: 'someone-else', type: 'fill', channel: 'luma', draft: H.draft() });
  await h.fill({ source: 'ebpg-hub', type: 'ping' });
  await h.fill('just a string');
  assert.deepEqual(h.replies, []);
  assert.deepEqual(h.sent, []);
  assert.equal(h.storage.data.draft, undefined);
});

test('a page on an origin that is not the hub cannot send drafts even to itself', async () => {
  const h = hub({ url: 'https://example.org/' });
  await h.fill(msg('partiful'), { origin: 'https://example.org' });
  assert.deepEqual(h.replies, []);
  assert.deepEqual(h.sent, []);
});

test('an unknown channel or a draft without a title gets a friendly error', async () => {
  const h = hub();
  await h.fill(msg('myspace'));
  h.advance(5000);
  await h.fill(msg('luma', H.draft({ title: '   ' })));
  assert.equal(h.replies.length, 2);
  assert.equal(h.replies[0].msg.type, 'error');
  assert.equal(h.replies[0].msg.source, 'ebpg-poster');
  assert.match(h.replies[0].msg.message, /does not know that site/);
  assert.match(h.replies[1].msg.message, /needs a title/);
  assert.deepEqual(h.sent, []);
});

test('an image over 5 MB is left out; the rest is saved, the site opens and the page hears why', async () => {
  const h = hub();
  const big = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(5 * 1024 * 1024 * 4 / 3) + 400);
  await h.fill(msg('partiful', H.draft({ imageDataUrl: big })));
  assert.equal(h.storage.data.draft.draft.title, H.draft().title);
  assert.equal(h.storage.data.draft.draft.imageDataUrl, '');
  assert.deepEqual(h.sent, [{ type: 'open', channel: 'partiful' }]);
  assert.equal(h.replies.length, 1);
  const r = h.replies[0].msg;
  assert.equal(r.type, 'opened');
  assert.equal(r.channel, 'partiful');
  assert.equal(r.imageDropped, true);
  assert.match(r.note, /larger than 5 MB, so the helper left it out/);
});

test('an image that is not a PNG, JPEG, WebP or GIF is left out the same way', async () => {
  const h = hub();
  await h.fill(msg('luma', H.draft({ imageDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })));
  assert.equal(h.storage.data.draft.draft.imageDataUrl, '');
  assert.equal(h.replies[0].msg.type, 'opened');
  assert.equal(h.replies[0].msg.imageDropped, true);
  assert.match(h.replies[0].msg.note, /not a PNG, JPEG, WebP or GIF/);
});

test('text over 20,000 characters is cut, and unsafe links are dropped', async () => {
  const h = hub();
  await h.fill(msg('meetup', H.draft({ text: 'x'.repeat(25000), description: 'y'.repeat(30000), eventUrl: 'javascript:alert(1)' })));
  const d = h.storage.data.draft.draft;
  assert.equal(d.text.length, 20000);
  assert.equal(d.description.length, 20000);
  assert.equal(d.eventUrl, '');
});

test('an error from the service worker (for example a missing group link) is passed on', async () => {
  const h = hub({ answer: { ok: false, error: 'Add the Guild’s Meetup group link in the Posting Helper options, then try again.' } });
  await h.fill(msg('meetup'));
  assert.equal(h.replies[0].msg.type, 'error');
  assert.equal(h.replies[0].msg.channel, 'meetup');
  assert.match(h.replies[0].msg.message, /Meetup group link/);
});

test('a double click opens one tab and the page hears only "opened"', async () => {
  const h = hub({ slowOpen: 20 });
  // The second click lands while the first is still saving and opening.
  const first = h.fill(msg('partiful'));
  await h.fill(msg('partiful'));
  assert.deepEqual(h.replies, [], 'no error is sent for the repeat');
  await first;
  h.advance(400);
  await h.fill(msg('partiful'));
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.replies.map(r => r.msg.type), ['opened']);
  // A different site right away is refused, with a reply for that site.
  await h.fill(msg('luma'));
  assert.equal(h.replies[1].msg.type, 'error');
  assert.equal(h.replies[1].msg.channel, 'luma');
  assert.match(h.replies[1].msg.message, /Still opening/);
  h.advance(2000);
  await h.fill(msg('luma'));
  assert.equal(h.sent.length, 2);
  assert.equal(h.replies[2].msg.type, 'opened');
});

test('if the event does not fit in storage with its image, it is saved without it and the site opens', async () => {
  const h = hub({ storageFailsWithImage: true });
  await h.fill(msg('partiful', H.draft({ imageDataUrl: H.TINY_PNG })));
  assert.equal(h.storage.data.draft.draft.title, H.draft().title);
  assert.equal(h.storage.data.draft.draft.imageDataUrl, '');
  assert.deepEqual(h.sent, [{ type: 'open', channel: 'partiful' }]);
  assert.equal(h.replies[0].msg.type, 'opened');
  assert.equal(h.replies[0].msg.imageDropped, true);
  assert.match(h.replies[0].msg.note, /could not save the image/);
});

test('if saving fails even without the image, the page is told', async () => {
  const h = hub({ storageFails: true });
  await h.fill(msg('partiful', H.draft({ imageDataUrl: H.TINY_PNG })));
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].msg.type, 'error');
  assert.match(h.replies[0].msg.message, /could not save this event/);
  assert.deepEqual(h.sent, []);
});

test('after the helper is reloaded, an old page is asked to reload', async () => {
  const h = hub({ noRuntime: true });
  await h.fill(msg('partiful'));
  assert.match(h.replies[0].msg.message, /Reload this page/);
});

test('a message event dispatched on the window reaches the bridge listener', async () => {
  const d = H.dom('<!doctype html><html><body></body></html>', HUB + '/site/');
  const win = d.window;
  const storage = H.storageArea();
  const sent = [];
  const runtime = { id: 'x', sendMessage: async m => { sent.push(m); return { ok: true }; } };
  const replies = [];
  win.postMessage = (m, origin) => replies.push({ m, origin });
  createHubBridge({ win, doc: win.document, runtime, storage, version: '1.0.0' }).start();
  // What Chrome delivers for the hub's window.postMessage(..., location.origin).
  win.dispatchEvent(new win.MessageEvent('message', { data: msg('hylo'), origin: HUB, source: win }));
  for (let i = 0; i < 20 && !replies.length; i++) await H.tick(5);
  assert.deepEqual(replies, [{ m: { source: 'ebpg-poster', type: 'opened', channel: 'hylo' }, origin: HUB }]);
  assert.equal(storage.data.draft.channel, 'hylo');
  assert.deepEqual(sent, [{ type: 'open', channel: 'hylo' }]);
});

// ---- shared.js ----

test('sanitizeDraft keeps good values, drops bad ones and never keeps unknown keys', () => {
  const { draft } = shared.sanitizeDraft(Object.assign(H.draft(), {
    date: '2026-02-30', start: '25:00', end: '13:00', extra: '<script>', title: '  Workday\u0000   #7  ', imageDataUrl: H.TINY_PNG
  }));
  assert.equal(draft.title, 'Workday #7');
  assert.equal(draft.date, '');
  assert.equal(draft.start, '');
  assert.equal(draft.end, '13:00');
  assert.equal('extra' in draft, false);
  assert.equal(draft.imageDataUrl, H.TINY_PNG);
  assert.match(shared.sanitizeDraft(null).error, /missing/);
  const linked = shared.sanitizeDraft(H.draft({ imageDataUrl: 'https://example.org/a.png' }));
  assert.equal(linked.error, undefined, 'a bad image never blocks the rest of the event');
  assert.equal(linked.draft.imageDataUrl, '');
  assert.match(linked.imageNote, /PNG, JPEG/);
  assert.equal('imageNote' in shared.sanitizeDraft(H.draft()), false);
});

test('channelForHost and normalizeGroupUrl only accept the real sites', () => {
  assert.equal(shared.channelForHost('partiful.com'), 'partiful');
  assert.equal(shared.channelForHost('lu.ma'), 'luma');
  assert.equal(shared.channelForHost('luma.com'), 'luma');
  assert.equal(shared.channelForHost('www.meetup.com'), 'meetup');
  assert.equal(shared.channelForHost('web.facebook.com'), 'facebook');
  assert.equal(shared.channelForHost('www.hylo.com'), 'hylo');
  assert.equal(shared.channelForHost('notfacebook.com'), null);
  assert.equal(shared.channelForHost('facebook.com.evil.example'), null);
  assert.equal(shared.normalizeGroupUrl('meetup', 'meetup.com/east-bay-permaculture'), 'https://meetup.com/east-bay-permaculture');
  assert.equal(shared.normalizeGroupUrl('facebook', 'http://www.facebook.com/groups/ebpg#top'), 'https://www.facebook.com/groups/ebpg');
  assert.equal(shared.normalizeGroupUrl('hylo', 'https://www.hylo.com/groups/ebpg'), 'https://www.hylo.com/groups/ebpg');
  assert.equal(shared.normalizeGroupUrl('facebook', 'https://evil.example/groups/ebpg'), null);
  assert.equal(shared.normalizeGroupUrl('facebook', 'javascript:alert(1)'), null);
  assert.equal(shared.normalizeGroupUrl('partiful', 'https://partiful.com/x'), null);
  assert.equal(shared.normalizeGroupUrl('hylo', ''), null);
});

test('formatters write dates and times the way people read them', () => {
  assert.equal(shared.longDate('2026-11-08'), 'Sunday, November 8, 2026');
  assert.equal(shared.time12('00:30'), '12:30 AM');
  assert.equal(shared.time12('13:05'), '1:05 PM');
  assert.equal(shared.timeRange('10:00', '13:00'), '10:00 AM to 1:00 PM');
  assert.equal(shared.timeRange('10:00', ''), '10:00 AM');
  assert.equal(shared.dateAs('2026-11-08', 'MM/DD/YYYY'), '11/08/2026');
  assert.equal(shared.dateAs('2026-11-08', 'dd/mm/yyyy'), '08/11/2026');
  assert.equal(shared.dateAs('2026-11-08', 'yyyy-mm-dd'), '2026-11-08');
  assert.equal(shared.dateAs('2026-11-08', 'mmm d, yyyy'), 'Nov 8, 2026');
  assert.equal(shared.placeLine('Oakland Peace Center', '111 Fairmount Ave'), 'Oakland Peace Center, 111 Fairmount Ave');
  assert.equal(shared.placeLine('Oakland Peace Center', 'Oakland Peace Center, 111 Fairmount Ave'), 'Oakland Peace Center, 111 Fairmount Ave');
  assert.equal(shared.ago(0, 30 * 1000), 'just now');
  assert.equal(shared.ago(0, 4 * 60 * 1000), '4 minutes ago');
  assert.equal(shared.ago(0, 2 * 3600 * 1000), '2 hours ago');
});

test('copyRows lists every field once, in order, skipping empty ones', () => {
  const rows = shared.copyRows(H.draft({ eventUrl: '' }));
  assert.deepEqual(rows.map(r => r.key), ['title', 'date', 'time', 'place', 'description', 'text']);
  const same = shared.copyRows(H.draft({ description: 'Same words', text: 'Same words' }));
  assert.deepEqual(same.map(r => r.key), ['title', 'date', 'time', 'place', 'text', 'link']);
});

test('a draft is fresh for 30 minutes after it was sent or re-opened', () => {
  const rec = { draft: H.draft(), timestamp: 0 };
  assert.equal(shared.isFresh(rec, 29 * 60 * 1000), true);
  assert.equal(shared.isFresh(rec, 31 * 60 * 1000), false);
  assert.equal(shared.isFresh(Object.assign({ openedAt: 20 * 60 * 1000 }, rec), 45 * 60 * 1000), true);
  assert.equal(shared.isFresh(null, 0), false);
});
