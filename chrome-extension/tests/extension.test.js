'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const shared = require('../src/shared.js');
const H = require('./helpers.js');

const read = f => fs.readFileSync(path.join(H.ROOT, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('manifest: Manifest V3, named EBPG Posting Helper, minimal permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'EBPG Posting Helper');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([...manifest.permissions].sort(), ['sidePanel', 'storage']);
  assert.equal(manifest.host_permissions, undefined, 'content-script matches are enough; no extra host access');
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.background.type, undefined, 'classic service worker so importScripts works');
});

test('manifest: the hub script runs at document_start on exactly the hub origins', () => {
  const hub = manifest.content_scripts.find(c => c.js.includes('src/hub-bridge.js'));
  assert.equal(hub.run_at, 'document_start');
  assert.deepEqual(hub.matches.map(m => m.replace(/\/\*$/, '')), shared.HUB_ORIGINS);
  assert.deepEqual(hub.js, ['src/shared.js', 'src/hub-bridge.js']);
});

test('manifest: the filling script runs on every target site and nowhere else', () => {
  const site = manifest.content_scripts.find(c => c.js.includes('src/site.js'));
  assert.deepEqual(site.js, ['src/shared.js', 'src/filler.js', 'src/panel.js', 'src/site.js']);
  const hosts = site.matches.map(m => /^https:\/\/\*\.([^/]+)\/\*$/.exec(m)[1]);
  assert.deepEqual(hosts, ['partiful.com', 'lu.ma', 'luma.com', 'meetup.com', 'facebook.com', 'hylo.com']);
  hosts.forEach(h => assert.ok(shared.channelForHost(h), h));
  assert.equal(manifest.content_scripts.length, 2);
});

test('manifest: every referenced file exists and the icons are real PNGs of the right size', () => {
  const files = [
    manifest.background.service_worker, manifest.action.default_popup, manifest.side_panel.default_path, manifest.options_ui.page,
    ...manifest.content_scripts.flatMap(c => c.js), ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)
  ];
  files.forEach(f => assert.ok(fs.existsSync(path.join(H.ROOT, f)), f));
  for (const [size, file] of Object.entries(manifest.icons)) {
    const buf = fs.readFileSync(path.join(H.ROOT, file));
    assert.equal(buf.slice(1, 4).toString(), 'PNG', file);
    assert.equal(buf.readUInt32BE(16), Number(size), file + ' width');
    assert.equal(buf.readUInt32BE(20), Number(size), file + ' height');
  }
});

test('no remote code: pages load only local scripts, and nothing uses eval', () => {
  for (const page of ['pages/popup.html', 'pages/sidepanel.html', 'pages/options.html']) {
    const html = read(page);
    const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
    assert.ok(srcs.length > 0, page);
    srcs.forEach(s => { assert.doesNotMatch(s, /^(https?:)?\/\//, `${page} loads ${s}`); assert.ok(fs.existsSync(path.join(H.ROOT, 'pages', s)), s); });
    assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/, `${page} has an inline script (blocked by the extension CSP)`);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/, `${page} loads a remote stylesheet`);
  }
  for (const f of fs.readdirSync(path.join(H.ROOT, 'src')).map(f => 'src/' + f).concat(['pages/common.js', 'pages/popup.js', 'pages/sidepanel.js', 'pages/options.js'])) {
    const src = read(f);
    assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(/, f);
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/, `${f} talks to the network`);
  }
});

test('the zip holds the extension and nothing from tests or node_modules', () => {
  const { listFiles, buildZip } = require('../tools/build-zip.js');
  const files = listFiles();
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('src/site.js'));
  assert.ok(files.includes('icons/icon-128.png'));
  assert.ok(files.every(f => !/^(tests|node_modules|dist|tools)\//.test(f)), files.join(', '));
  const zip = buildZip(files);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'starts with a zip local header');
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, 'ends with the zip directory record');
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), files.length);
});

// ---- Extension pages, run in jsdom with a stand-in chrome API ----

function loadPage(file, opts) {
  const o = opts || {};
  const html = read('pages/' + file).replace(/<script[^>]*><\/script>/g, '');
  const d = new JSDOM(html, { url: 'chrome-extension://abc/pages/' + file + (o.query || ''), runScripts: 'outside-only', pretendToBeVisual: true });
  const win = d.window;
  const local = H.storageArea(o.local), sync = H.storageArea(o.sync);
  const changed = [];
  const sent = [];
  const calls = { options: 0, sidePanel: 0, tabs: [] };
  local.onChanged = changed;
  win.chrome = {
    storage: { local, sync, onChanged: { addListener: fn => changed.push(fn) } },
    runtime: { sendMessage: async m => { sent.push(JSON.parse(JSON.stringify(m))); return o.answer ? o.answer(m) : { ok: true }; }, openOptionsPage: () => { calls.options++; }, getURL: p => 'chrome-extension://abc/' + p },
    tabs: { query: async () => [{ id: 9, windowId: 1 }], create: async p => { calls.tabs.push(p); } },
    sidePanel: { open: async () => { calls.sidePanel++; } }
  };
  win.URL.createObjectURL = () => 'blob:chrome-extension://abc/img';
  win.URL.revokeObjectURL = () => {};
  win.close = () => {};
  const copied = [];
  Object.defineProperty(win.navigator, 'clipboard', { configurable: true, value: { writeText: async t => { copied.push(t); } } });
  for (const s of ['../src/shared.js', 'common.js', file.replace('.html', '.js')]) win.eval(read(path.posix.join('pages', s)));
  return { win, doc: win.document, local, sync, sent, calls, copied, changed };
}

const rec = (extra) => Object.assign({ channel: 'partiful', timestamp: Date.now() - 4 * 60 * 1000, origin: 'http://localhost:8766', draft: H.draft({ imageDataUrl: H.TINY_PNG }) }, extra || {});

test('side panel: shows the event, a Copy button per field and the image download', async () => {
  const p = loadPage('sidepanel.html', { local: { draft: rec() } });
  await H.tick(20);
  assert.equal(p.doc.getElementById('empty').hidden, true);
  assert.equal(p.doc.getElementById('d-title').textContent, H.draft().title);
  assert.equal(p.doc.getElementById('d-meta').textContent, 'From the Event Hub for Partiful · 4 minutes ago');
  assert.equal(p.doc.getElementById('d-when').textContent, 'Sunday, November 8, 2026 · 10:00 AM to 1:00 PM · Oakland Peace Center');
  const rows = [...p.doc.querySelectorAll('#d-rows li .lab')].map(l => l.textContent);
  assert.deepEqual(rows, ['Title', 'Date', 'Time', 'Place', 'Description', 'Full text', 'Event link']);
  const dl = p.doc.getElementById('d-dl');
  assert.equal(dl.getAttribute('download'), 'workday-7-sheet-mulching-the-food-forest.png');
  assert.equal(dl.textContent, 'Download image');
  assert.equal(p.doc.getElementById('d-ig').hidden, true);
  const copy = p.doc.querySelector('#d-rows button[aria-label="Copy place"]');
  copy.click();
  await H.tick(50);
  assert.deepEqual(p.copied, ['Oakland Peace Center, 111 Fairmount Ave, Oakland, CA 94611']);
  assert.equal(p.doc.getElementById('status').textContent, 'Place copied.');
  const names = [...p.doc.querySelectorAll('#targets button')].map(b => b.textContent);
  assert.deepEqual(names, ['Partiful', 'Luma', 'Meetup', 'Facebook', 'Hylo', 'Instagram']);
});

test('side panel: Instagram drafts say how to post; site buttons ask the service worker', async () => {
  const p = loadPage('sidepanel.html', { local: { draft: rec({ channel: 'instagram' }) }, answer: () => ({ ok: false, error: 'Add the Guild’s Meetup group link in the Posting Helper options, then try again.' }) });
  await H.tick(20);
  assert.equal(p.doc.getElementById('d-ig').hidden, false);
  p.doc.querySelector('#targets button[aria-label="Open Meetup and fill it"]').click();
  await H.tick(60);
  assert.deepEqual(p.sent, [{ type: 'open-target', channel: 'meetup' }]);
  assert.match(p.doc.getElementById('status').textContent, /Meetup group link/);
  assert.equal(p.doc.getElementById('status').classList.contains('bad'), true);
});

test('side panel: empty state when no event has been sent', async () => {
  const p = loadPage('sidepanel.html');
  await H.tick(20);
  assert.equal(p.doc.getElementById('empty').hidden, false);
  assert.equal(p.doc.getElementById('draft').hidden, true);
  assert.ok([...p.doc.querySelectorAll('#targets button')].every(b => b.disabled));
});

test('popup: names the loaded event and fills the current tab', async () => {
  const p = loadPage('popup.html', { local: { draft: rec() }, answer: m => (m.type === 'fill-tab' ? { ok: true, count: 4 } : { ok: true }) });
  await H.tick(20);
  const state = p.doc.getElementById('state').textContent;
  assert.match(state, /Event loaded for Partiful/);
  assert.match(state, /Workday #7: Sheet mulching the food forest/);
  assert.match(state, /4 minutes ago/);
  p.doc.getElementById('fill').click();
  await H.tick(60);
  assert.deepEqual(p.sent, [{ type: 'fill-tab', tabId: 9 }]);
  assert.equal(p.doc.getElementById('status').textContent, 'Filled 4 fields. Review everything, then publish.');
  p.doc.getElementById('panel').click();
  await H.tick(20);
  assert.equal(p.calls.sidePanel, 1);
});

test('popup: says when nothing is loaded', async () => {
  const p = loadPage('popup.html');
  await H.tick(20);
  assert.match(p.doc.getElementById('state').textContent, /No event loaded/);
  assert.equal(p.doc.getElementById('fill').disabled, true);
});

test('options: saves valid group links, rejects links on other sites, shows the missing-link note', async () => {
  const p = loadPage('options.html', { local: { notice: { channel: 'hylo', at: Date.now() } } });
  await H.tick(20);
  const notice = p.doc.getElementById('notice');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /Hylo group link/);
  assert.equal(p.doc.activeElement.id, 'hyloUrl');
  assert.equal(p.local.data.notice, undefined, 'the note shows once');

  p.doc.getElementById('meetupUrl').value = 'meetup.com/east-bay-permaculture';
  p.doc.getElementById('facebookUrl').value = 'https://evil.example/groups/x';
  p.doc.getElementById('form').dispatchEvent(new p.win.Event('submit', { cancelable: true }));
  await H.tick(50);
  assert.equal(p.doc.getElementById('facebookUrl').getAttribute('aria-invalid'), 'true');
  assert.match(p.doc.getElementById('facebookUrl-err').textContent, /facebook\.com/);
  assert.deepEqual(p.sync.data, {}, 'nothing saved while a link is wrong');

  p.doc.getElementById('facebookUrl').value = 'www.facebook.com/groups/ebpg';
  p.doc.getElementById('form').dispatchEvent(new p.win.Event('submit', { cancelable: true }));
  await H.tick(50);
  assert.deepEqual(p.sync.data, { meetupUrl: 'https://meetup.com/east-bay-permaculture', facebookUrl: 'https://www.facebook.com/groups/ebpg', hyloUrl: '' });
  assert.equal(p.doc.getElementById('status').textContent, 'Saved.');

  p.local.data.draft = rec();
  p.doc.getElementById('forget').click();
  await H.tick(50);
  assert.equal(p.local.data.draft, undefined);
});
