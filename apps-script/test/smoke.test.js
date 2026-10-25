/* Headless smoke test of the real Netlify page (site/index.html) against the mock backend.
   Each test loads the page fresh in jsdom with a fresh mock Sheet, so no browser is needed.
   Build first: python3 build.py   Run: node --test test/   (or node --test test/smoke.test.js)

   What the page gets that jsdom lacks: every POST goes to Code.js doPost on the mock, and
   scrollTo, matchMedia, the observers, the clipboard, canvas, window.open and downloads are stubbed.
   The page clock is pinned to the morning of Oct 24 2026 (and the mock follows it), so the
   starter events stay "upcoming" whatever day the test runs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeGas } = require('./gas-mock');

const SITE = path.join(__dirname, '..', 'site', 'index.html');
const ARTIFACT = path.join(__dirname, '..', '..', 'event-hub', 'src.html'); // the prototype artifact's source
const PROTO_WORDS = /prototype|simulated|hackathon|claude\.ai|sample data|stand-in|Continue with Google|Viewing as|Weekend build plan|approveAndPublish/i;
const FRIENDLY = 'Something went wrong. Please refresh the page. If it keeps happening, email the Guild.';
const MISSING = 'site/index.html is missing. Build it first: cd apps-script && python3 build.py';
const START = Date.UTC(2026, 9, 24, 17, 0); // 10:00 AM in Oakland
const NOISE = /^Could not parse CSS stylesheet/; // jsdom's CSS parser lags behind browsers; not a page bug
const FAILED = /\bcouldn['’]t\b|no connection|didn['’]t answer|^not saved/i; // how the page words a failed call in its toast

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 4000, what = 'the condition') {
  const until = Date.now() + ms;
  let last;
  for (;;) {
    try { const v = fn(); if (v) return v; } catch (e) { last = e; }
    if (Date.now() > until) throw new Error(`Timed out after ${ms} ms waiting for ${what}` + (last ? ` (last error: ${last.message})` : ''));
    await sleep(20);
  }
}

/* stand-ins for browser features jsdom doesn't have */
function stub(w, g, api) {
  const RealDate = w.Date, offset = START - RealDate.now();
  w.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  };
  w.fetch = (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      api.errors.push(`unexpected ${method} ${url}`);
      return w.Promise.reject(new w.TypeError('Failed to fetch'));
    }
    const body = String(opts.body || '');
    let fn = '?', args = [];
    try { ({ fn, args } = JSON.parse(body)); } catch {}
    api.calls.push(fn); api.sent.push({ fn, args }); api.pending++;
    api.out[fn] = (api.out[fn] || 0) + 1;
    api.most[fn] = Math.max(api.most[fn] || 0, api.out[fn]);
    // api.latency slows every call; api.fail names functions that get Apps Script's HTML error page instead of JSON
    const fail = String(api.fail || '').split(',').includes(fn);
    return new w.Promise(resolve => w.setTimeout(() => {
      g.clock.now = w.Date.now();
      api.pending--; api.out[fn]--;
      if (fail) return resolve({ ok: false, status: 502, headers: new w.Headers({ 'content-type': 'text/html; charset=utf-8' }), json: async () => { throw new w.SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"); }, text: async () => '<!DOCTYPE html><title>Error</title>' });
      const out = g.ctx.doPost({ postData: { contents: body } });
      api.done.push({ fn, args });
      resolve({ ok: true, status: 200, headers: new w.Headers({ 'content-type': 'application/json; charset=utf-8' }), json: async () => w.JSON.parse(out.content), text: async () => out.content });
    }, api.latency || 0));
  };
  w.scrollTo = () => {};
  w.scrollBy = () => {};
  w.Element.prototype.scrollIntoView = w.Element.prototype.scrollIntoView || function () {};
  w.matchMedia = w.matchMedia || (media => ({ media, matches: false, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const Observer = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  for (const k of ['IntersectionObserver', 'ResizeObserver']) if (!w[k]) w[k] = Observer;
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async t => { api.copied.push(String(t)); }, readText: async () => api.copied.at(-1) || '' } });
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.open = (u = '') => { api.opened.push(String(u)); return null; };
  // downloads: a Blob's object URL, and a click on <a download> is kept in api.downloads instead of navigating (jsdom can't)
  w.URL.createObjectURL = b => { api.blobs.push(b); return 'blob:http://localhost/' + api.blobs.length; };
  w.URL.revokeObjectURL = () => {};
  w.addEventListener('click', e => {
    const a = e.target && e.target.closest && e.target.closest('a[download]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    api.downloads.push({ name: a.download, href, blob: /^blob:/.test(href) ? api.blobs[Number(href.split('/').pop()) - 1] : null });
  }, true);
  w.alert = () => {};
  w.confirm = () => true;
  w.prompt = () => null;
  w.addEventListener('error', e => api.errors.push('page error: ' + ((e.error && e.error.stack) || e.message)));
}

/* shown on screen: no hidden attribute and no display:none (from the page's CSS) on it or any parent */
const onScreen = (w, el) => { for (; el && el.nodeType === 1; el = el.parentElement) if (el.hidden || w.getComputedStyle(el).display === 'none') return false; return true; };

/* load a page in a fresh jsdom with a fresh mock Sheet (or `sheet`, another page's mock, for a reload);
   before(w, g) runs before the page's scripts */
function loadPage(t, file, url, before, sheet) {
  const g = sheet || makeGas({ page: undefined, now: START, settings: { ORGANIZER_CODE: 'garden-test-2468' } }); // the code starts blank, so set one
  const api = { errors: [], calls: [], sent: [], done: [], out: {}, most: {}, latency: 0, fail: '', pending: 0, copied: [], opened: [], toasts: [], blobs: [], downloads: [] };
  const vc = new VirtualConsole();
  vc.on('error', (...a) => api.errors.push('console.error: ' + a.map(x => (x && x.stack) || String(x)).join(' ')));
  vc.on('jsdomError', e => { if (!NOISE.test(e.message)) api.errors.push('jsdom: ' + ((e.detail && e.detail.stack) || e.stack || e.message)); });
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    runScripts: 'dangerously', pretendToBeVisual: true, url, virtualConsole: vc,
    beforeParse: w => { stub(w, g, api); if (before) before(w, g, api); },
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  // keep every toast, so a "Couldn't save" the page shows instead of throwing still fails the test
  const toast = d.getElementById('toast');
  if (toast) {
    const seen = () => { const s = toast.textContent.trim(); if (s) api.toasts.push(s); };
    seen();
    new w.MutationObserver(seen).observe(toast, { childList: true, characterData: true, subtree: true });
  }
  const p = {
    w, d, g, api,
    $: s => d.querySelector(s),
    $$: s => [...d.querySelectorAll(s)],
    shown: s => { const el = d.querySelector(s); return !!el && !el.hidden; },
    visible: s => onScreen(w, typeof s === 'string' ? d.querySelector(s) : s),
    idle: () => api.pending === 0,
    set(sel, v) { const el = d.querySelector(sel); assert.ok(el, sel + ' exists'); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    code: () => (g.tab('Settings').find(r => r[0] === 'ORGANIZER_CODE') || [])[1],
    noErrors: () => {
      assert.deepEqual(api.errors, [], 'no script errors on the page');
      assert.deepEqual(api.toasts.filter(s => FAILED.test(s)), [], 'no failure messages on the page');
    },
  };
  return p;
}
/* the built Netlify page; waits for its first call to finish */
async function openPage(t, before, sheet) {
  assert.ok(fs.existsSync(SITE), MISSING);
  const p = loadPage(t, SITE, 'http://localhost:8766/site', before, sheet);
  await waitFor(() => p.api.calls.includes('getPublic') && p.idle(), 4000, 'the page to load the public events');
  return p;
}

/* type the code and pick an organizer (the first one unless named); returns the name picked.
   A Sheet nobody has set up has no names to pick: Continue checks the code and fills the Sheet first,
   and the names come with its answer ('' if Continue was turned down). */
const NAMES = '#si-pick button[data-as]:not([data-first])';
async function startSignIn(p, code, who) {
  p.$('#signin-top').click();
  await waitFor(() => p.shown('#p-signin'), 2000, 'the sign-in page');
  assert.ok(p.shown('#si-codew') && p.visible('#si-codew'), 'the organizer code field is shown');
  p.set('#si-code', code);
  const first = await waitFor(() => p.$('#si-pick [data-first]') || p.$(NAMES), 4000, 'the names, or Continue');
  if (first.hasAttribute('data-first')) {
    first.click();
    await waitFor(() => p.shown('#si-err') || p.$(NAMES), 8000, 'the Sheet to answer Continue');
    if (p.shown('#si-err')) return '';
  }
  const pick = await waitFor(() => p.$(who ? `#si-pick button[data-as="${who}"]` : NAMES), 2000, 'an organizer to pick');
  pick.click();
  return pick.dataset.as;
}
/* a mock Sheet an organizer has already set up: the starter events and the team are in it */
async function seededSheet(t) {
  const s = await openPage(t);
  await signIn(s);
  s.$('#signout').click();
  await waitFor(s.idle, 2000, 'the first sign-in to finish');
  s.noErrors();
  return s.g;
}
async function signIn(p, who) {
  const name = await startSignIn(p, p.code(), who);
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out') && p.$('#tiles [data-open]'), 4000, 'the events page after sign-in');
  await waitFor(p.idle, 2000, 'sign-in calls to finish');
  return name;
}

test('the built page exists', () => assert.ok(fs.existsSync(SITE), MISSING));

test('landing page renders with upcoming events', async t => {
  const p = await openPage(t, null, await seededSheet(t));
  assert.ok(p.shown('#p-landing'), 'landing page is visible');
  assert.ok(!p.shown('#p-events'), 'organizer pages stay hidden');
  assert.ok(p.d.body.classList.contains('out'), 'signed out');
  const cards = p.$$('#nextup > *');
  assert.ok(cards.length >= 1, 'at least one upcoming event card');
  assert.ok(cards.every(c => c.textContent.trim()), 'cards have text');
  assert.ok(p.$$('#nextup a.nxcard').length >= 1, 'at least one upcoming Guild event from the Sheet');
  assert.ok(p.$$(NAMES).length >= 1, 'organizers to sign in as');
  assert.ok(!p.$('#err-bar') && !p.d.body.textContent.includes('Something went wrong'), 'no error bar');
  p.noErrors();
});

test('a wrong organizer code shows an error and saves nothing', async t => {
  const p = await openPage(t);
  await startSignIn(p, 'not-the-code');
  const err = await waitFor(() => p.shown('#si-err') && p.$('#si-err'), 4000, 'the sign-in error');
  assert.match(err.textContent, /organizer code/i);
  assert.ok(p.shown('#p-signin'), 'still on the sign-in page');
  assert.ok(p.d.body.classList.contains('out'), 'still signed out');
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.ok(!p.api.calls.includes('seed'), 'no seed call');
  assert.equal(p.g.tab('Events').length, 1, 'Events tab has only its header row');
  assert.equal(p.w.sessionStorage.getItem('ebpg-code'), null, 'the wrong code is not remembered');
  p.noErrors();
});

test('the right code signs in, fills the empty Sheet and shows the events', async t => {
  const p = await openPage(t);
  assert.ok(p.code(), 'the Settings tab has an organizer code');
  assert.equal(p.g.tab('Events').length, 1, 'the Sheet starts empty');
  const name = await signIn(p);
  assert.ok(p.api.calls.includes('signIn') && p.api.calls.includes('seed'), 'signIn then seed');
  assert.ok(p.g.tab('Events').length > 1, 'events were written to the Events tab');
  assert.ok(p.g.tab('Team').length > 1, 'the team was written to the Team tab');
  assert.equal(p.g.tab('Volunteers').length, 1, 'no made-up volunteers: the Volunteers tab has only its header');
  assert.equal((p.g.tab('Settings').find(r => r[0] === 'SEEDED') || [])[1], 'TRUE', 'the Sheet is marked as filled');
  const ids = p.g.tab('Events').slice(1).map(r => r[0]);
  const tiles = p.$$('#tiles [data-open]');
  assert.ok(tiles.length >= 1, 'event tiles are shown');
  assert.ok(tiles.every(el => ids.includes(el.dataset.open)), 'every tile is an event from the Sheet');
  assert.ok(!p.shown('#p-landing') && !p.shown('#p-signin'), 'landing and sign-in are hidden');
  assert.equal(p.w.sessionStorage.getItem('ebpg-code'), p.code(), 'the code is kept for this tab');
  assert.ok(p.api.toasts.includes('Signed in as ' + name), 'the page says who is signed in');
  p.noErrors();
});

test('editing an event title saves it to the Events tab', async t => {
  const p = await openPage(t);
  await signIn(p);
  const tile = p.$('#tiles [data-open]'), id = tile.dataset.open;
  tile.click();
  const edit = await waitFor(() => p.$('#detail #edit-ev'), 2000, 'the event to open');
  assert.ok(!edit.disabled, 'the organizer can edit');
  edit.click();
  await waitFor(() => p.$('#editf #ed-title'), 2000, 'the edit form');
  const title = 'Fall Planting Work Party';
  p.set('#ed-title', title);
  p.$('#editf button[type=submit]').click();
  await waitFor(() => !p.$('#editf'), 2000, 'the edit form to close');
  const row = () => p.g.tab('Events').find(r => r[0] === id);
  assert.notEqual(row()[2], title, 'not saved before the debounce');
  assert.ok(!p.api.toasts.includes('Saved'), '"Saved" waits for the Sheet');
  await waitFor(() => row()[2] === title, 3000, 'the new title in the Events tab');
  await waitFor(() => p.api.toasts.at(-1) === 'Saved', 2000, 'the Saved toast once the Sheet has it');
  assert.ok(p.api.calls.includes('saveEvent'), 'saveEvent was called');
  assert.ok(p.g.tab('Activity').some(r => r[0] === id && /edited the event/.test(r[2])), 'the edit is in the Activity tab');
  await waitFor(p.idle, 2000, 'saves to finish');
  p.noErrors();
});

test('the volunteer form adds a row to the Volunteers tab', async t => {
  const p = await openPage(t);
  const submit = () => p.$('#joinf button[type=submit]').click();
  submit();
  assert.ok(p.shown('#vj-err'), 'an empty form shows an error');
  assert.equal(p.g.tab('Volunteers').length, 1, 'nothing saved for an empty form');
  p.set('#vj-name', 'Sam Rivera');
  p.set('#vj-contact', 'sam.rivera@example.org');
  p.set('#vj-note', 'Weekends work best');
  const box = p.$('#vj-picks input[name=vj-help]');
  assert.ok(box, 'there are ways to help to pick');
  box.click();
  submit();
  await waitFor(() => p.shown('#joined'), 2000, 'the thank-you message');
  assert.match(p.$('#joined').textContent, /Thanks, Sam!/);
  const row = await waitFor(() => p.g.tab('Volunteers').find(r => r[1] === 'Sam Rivera'), 3000, 'the Volunteers row');
  assert.equal(row[0], '2026-10-24');
  assert.equal(row[2], 'sam.rivera@example.org');
  assert.ok(row[3].length > 0, 'what they want to help with');
  assert.equal(row[4], 'Weekends work best');
  assert.ok(p.g.mail.some(m => /Welcome to the East Bay Permaculture Guild/.test(m.subject)), 'welcome email sent');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('the starter data is honest: drafts, open tasks, blank contacts, no sign-ups', async t => {
  const p = await openPage(t);
  await signIn(p);
  // nothing invented in the Sheet
  const all = JSON.stringify([...p.g.sheets.keys()].map(k => p.g.tab(k)));
  for (const bad of ['example.org', '555-01', 'Alex R.', 'Sausal', 'approved Partiful', 'posted automatically']) assert.ok(!all.includes(bad), bad + ' is not in the Sheet');
  assert.equal(p.g.tab('Gardens').length, 2, 'only the Oakland Peace Center garden');
  const posts = p.g.tab('Posts').slice(1);
  assert.ok(posts.length > 0 && posts.every(r => r[2] === 'review' && !r[3]), 'every Posts row is an unreviewed draft');
  assert.deepEqual([...new Set(posts.map(r => r[0]))].sort(), ['m2', 'w7'], 'past events have no Posts rows');

  // Workday #7: drafts only, one Activity line, open tasks with last-time hints
  p.$('#tiles [data-open="w7"]').click();
  await waitFor(() => p.$('#detail #dp-plan'), 2000, 'Workday #7 to open');
  const rows = p.$$('#detail .who-tbl tbody tr');
  assert.ok(rows.length >= 4, 'the copied tasks plus the parking sign');
  assert.ok(rows.every(r => /Needs someone/.test(r.textContent)), 'every task needs someone');
  const hints = p.$$('#detail .who-tbl .last').map(x => x.textContent);
  assert.ok(hints.includes('Last time: Phil') && hints.includes('Last time: Karen'), hints.join(', '));
  p.$('#detail [data-dtab="outreach"]').click();
  await waitFor(() => p.shown('#dp-out'), 2000, 'the Outreach tab');
  const chans = p.$$('#dp-out .orow');
  assert.ok(chans.length >= 1, 'channels to post to');
  assert.ok(chans.every(r => r.classList.contains('review')), 'every channel is a draft');
  assert.ok(!p.$('#dp-out').textContent.includes('Posted ✓'), "nothing says it's posted");
  const log = p.$$('#log-body li');
  assert.equal(log.length, 1, 'one Activity line');
  assert.match(log[0].textContent, /drafted Workday #7 from Workday #6/);
  p.$('#m-x').click();

  // a past event: no outreach on record, one import line, no 'Also post to'
  p.$('[data-when="past"]').click();
  p.$('#tiles [data-open="w6"]').click();
  await waitFor(() => p.shown('#dp-out'), 2000, 'Workday #6 on the Outreach tab');
  assert.match(p.$('#dp-out .osum').textContent, /No outreach recorded for this event\./);
  assert.ok(!p.$('#add-ch'), "no 'Also post to' on a past event");
  assert.deepEqual(p.$$('#log-body li').map(li => [...li.children].map(x => x.textContent).join(' | ')), ['Sep 27 | Imported from the Guild planning notes']);
  assert.ok(!p.$('#detail').textContent.includes('date assumed'));
  p.$('#m-x').click();

  // Team: blank contacts are flagged; the volunteer list is empty
  const chips = p.$$('#team-tbl .warnchip');
  assert.equal(chips.length, p.$$('#team-tbl tbody tr').length, 'every person has a No contact yet chip');
  assert.ok(chips.every(c => c.textContent === 'No contact yet'));
  assert.match(p.$('#vol-tbl').textContent, /No sign-ups yet\. People who join on the home page show up here\./);
  assert.equal(p.$('#ap-name').placeholder, 'Name');
  assert.equal(p.$('#ap-contact').placeholder, 'Phone or email');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

/* ---------- the live page has no prototype-only content ---------- */
test('the live page has none of the prototype wording; the artifact source keeps it', () => {
  const live = fs.readFileSync(SITE, 'utf8');
  assert.deepEqual(live.split('\n').filter(l => PROTO_WORDS.test(l)).map(l => l.trim().slice(0, 140)), [], 'lines with prototype wording');
  assert.ok(!/PROTO(-->|\*\/)/.test(live), 'no PROTO markers left');
  for (const id of ['p-architecture', 'si-google', 'as', 'opt-a']) assert.ok(!live.includes(`id="${id}"`), id + ' is not in the live page');
  const src = fs.readFileSync(ARTIFACT, 'utf8');
  for (const s of ["How we'd build it", 'Continue with Google', 'Prototype sign-in', 'Sample data', 'Stand-in photos', 'Viewing as', 'Weekend build plan', '(simulated)', 'claude.ai/artifact'])
    assert.ok(src.includes(s), s + ' is still in the artifact');
});

test('the sign-in card asks only for the organizer code and who you are', async t => {
  const p = await openPage(t, null, await seededSheet(t));
  p.$('#signin-top').click();
  await waitFor(() => p.shown('#p-signin'), 2000, 'the sign-in page');
  const card = p.$('#p-signin .scard'), seen = [...card.querySelectorAll('input, button, select, textarea, a')].filter(p.visible);
  assert.deepEqual(seen.filter(el => el.tagName === 'INPUT').map(el => el.id), ['si-code', 'si-rem']);
  assert.equal(p.$('#si-rem').closest('label').textContent, 'Remember this device for 30 days');
  assert.equal(p.$('#si-rem').checked, false, 'not remembered unless ticked');
  const buttons = seen.filter(el => el.tagName === 'BUTTON');
  assert.ok(buttons.length > 1 && buttons.slice(0, -1).every(b => b.dataset.as), 'the name picker');
  assert.equal(buttons.at(-1).id, 'si-back', 'and the way back');
  assert.ok(!/google|prototype|nothing is saved/i.test(card.textContent), card.textContent);
  assert.ok(p.visible('#si-then') && p.visible(card.querySelector('.demo')));
  assert.match(card.textContent, /Ask the lead organizer for the code\./);
  p.noErrors();
});

test("signed in as Phil: the chip, the four tabs, plain-words permissions and the Help page", async t => {
  const p = await openPage(t);
  assert.ok(!p.visible('#who') && !p.visible('.tabs'), 'no chip or tabs while signed out');
  assert.equal(p.$('#help-sheet').textContent, 'Ask the Sheet owner for the link.', 'no Sheet link before sign-in');
  await signIn(p, 'Phil');
  assert.ok(p.visible('#who'), 'the chip is shown');
  assert.equal(p.$('#who > span:last-child').textContent, 'Signed in as Phil · Co-organizer');
  assert.equal(p.$('#who .vh').textContent, 'Signed in as ', 'the "Signed in as" part is for screen readers');
  assert.equal(p.$('#who .av').textContent, 'P', 'with the avatar');
  assert.equal(p.$('#who .av').getAttribute('aria-hidden'), 'true');
  assert.deepEqual(p.$$('.tabs a').filter(p.visible).map(a => a.textContent), ['Events', 'Team', 'Flyers & posts', 'Help']);
  const note = "You can't manage the team. Ask Jessie if you need to.";
  assert.equal(p.$('#team-note').textContent, note);
  p.$('#tiles [data-open]').click();
  assert.equal((await waitFor(() => p.$('#detail #perm-note'), 2000, 'the permissions note')).textContent, note);
  p.$('#m-x').click();

  p.$('.tabs a[data-tab=help]').click();
  assert.ok(p.visible('#p-help') && !p.visible('#p-events'), 'the Help page is shown');
  assert.equal(p.$('.tabs a[aria-current=page]').textContent, 'Help');
  const link = p.$('#help-sheet a');
  assert.equal(link.textContent, 'Open the Guild Sheet');
  assert.equal(link.href, 'https://docs.google.com/spreadsheets/d/sheet-1/edit');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener');
  const help = p.$('#p-help').textContent.replace(/\s+/g, ' ');
  for (const s of ['ORGANIZER_CODE', 'Settings', 'TEST_MODE', 'goes only to the Sheet', '6 PM the evening before', 'between 8 AM and noon on the day', 'shows up here within two minutes, or as soon as you come back to this tab', 'Not saved'])
    assert.ok(help.includes(s), s);
  assert.match(p.$('#help-lead').textContent, /^Jessie is the lead organizer\. Ask Jessie/);

  // signing out hides the chip; a co-organizer missing two permissions gets both in plain words
  p.$('#signout').click();
  assert.ok(p.d.body.classList.contains('out') && !p.visible('#who') && !p.visible('#p-help'), 'signed out');
  await signIn(p, 'Kalynn');
  assert.equal(p.$('#who > span:last-child').textContent, 'Signed in as Kalynn · Co-organizer');
  p.$('#tiles [data-open]').click();
  assert.equal((await waitFor(() => p.$('#detail #perm-note'), 2000, 'the permissions note')).textContent, "You can't approve posts or manage the team. Ask Jessie if you need to.");
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('a script error shows the friendly bar with a Dismiss button, and the details go to the console', async t => {
  const p = await openPage(t);
  const fire = (message, filename = 'http://localhost:8766/site') => p.w.dispatchEvent(new p.w.ErrorEvent('error', { message, filename, lineno: 3, colno: 7 }));
  fire('Script error.', '');
  fire('ResizeObserver loop completed with undelivered notifications.');
  fire('TypeError: x is undefined', 'chrome-extension://abcdefgh/content.js');
  fire('TypeError: x is undefined', 'moz-extension://abcdefgh/content.js');
  fire('TypeError: x is undefined', 'safari-extension://abcdefgh/content.js');
  assert.ok(!p.$('#err-bar'), 'extension, cross-origin and ResizeObserver noise shows nothing');
  assert.ok(!p.api.errors.some(e => /Event Hub error/.test(e)), 'and is not logged');

  // a real error from page script
  const s = p.d.createElement('script');
  s.textContent = 'document.getElementById("no-such-thing").secretDetail = 1;';
  p.d.body.appendChild(s);
  const bar = await waitFor(() => p.$('#err-bar'), 2000, 'the error bar');
  assert.equal(bar.getAttribute('role'), 'alert');
  assert.equal(bar.querySelector('span').textContent, FRIENDLY);
  assert.ok(!/secretDetail|null|TypeError|line/i.test(bar.textContent), 'no raw message: ' + bar.textContent);
  assert.ok(p.api.errors.some(e => /^console\.error: Event Hub error: .*secretDetail/.test(e)), 'the details are in the console');
  fire('Another one');
  assert.equal(p.$$('#err-bar').length, 1, 'one bar at a time');
  const dismiss = bar.querySelector('button');
  assert.equal(dismiss.textContent, 'Dismiss');
  dismiss.click();
  assert.ok(!p.$('#err-bar'), 'Dismiss removes the bar');
});

test('the Netlify and Google-hosted pages use the same error script', () => {
  const head = fs.readFileSync(SITE, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const google = makeGas().ctx.doGet({ parameter: {} }).content.match(/^<script>([\s\S]*?)<\/script>/)[1];
  const onErr = js => js.split('window.EBPG_GAS=')[0];
  assert.ok(onErr(head).includes(FRIENDLY));
  assert.equal(onErr(head), onErr(google), 'build.py on_err and Code.js ON_ERROR match');
});

/* ---------- icons and the event pop-up ---------- */
const ICONS = ['x', 'arrow-left', 'arrow-right', 'arrow-down', 'log-in', 'log-out', 'calendar', 'calendar-plus', 'clock', 'map-pin', 'users', 'user-plus', 'user-minus', 'user-check',
  'pencil', 'send', 'link', 'copy', 'share', 'file-text', 'list-ordered', 'package', 'lightbulb', 'alert-triangle', 'heart', 'sprout', 'shovel', 'handshake', 'image',
  'lock', 'mail', 'phone', 'message-circle', 'history', 'eye', 'rotate-ccw', 'printer', 'help-circle', 'download', 'plus', 'check', 'out'];
const GLYPHS = /[↗←×↓✓]/;
/* every icon on screen points at a symbol in the sprite and is hidden from screen readers */
function checkIcons(p, where) {
  const uses = p.$$('use').map(u => u.getAttribute('href')).filter(h => h.startsWith('#i-'));
  const missing = [...new Set(uses)].filter(h => !p.d.querySelector('symbol' + h));
  assert.deepEqual(missing, [], `icons with no symbol (${where})`);
  const loud = p.$$('svg.ic').filter(svg => svg.getAttribute('aria-hidden') !== 'true');
  assert.equal(loud.length, 0, `icons that screen readers would read (${where})`);
  const typed = p.$$('a, button').filter(el => GLYPHS.test(el.textContent)).map(el => el.textContent.trim());
  assert.deepEqual(typed, [], `typed arrows or crosses in links and buttons (${where})`);
  const mute = p.$$('button').filter(b => !b.textContent.trim() && !b.getAttribute('aria-label'));
  assert.deepEqual(mute.map(b => b.outerHTML.slice(0, 80)), [], `icon-only buttons need an aria-label (${where})`);
}

test('icons: the sprite has the set, every icon resolves, and none are read aloud', async t => {
  const p = await openPage(t, null, await seededSheet(t));
  for (const n of ICONS) {
    const sym = p.$('symbol#i-' + n);
    assert.ok(sym, 'symbol i-' + n);
    assert.equal(sym.getAttribute('viewBox'), '0 0 24 24', n + ' uses the 24px grid');
    const g = sym.querySelector('g');
    assert.ok(g && g.getAttribute('stroke') === 'currentColor' && g.getAttribute('stroke-width') === '2' && g.getAttribute('fill') === 'none', n + ' uses the shared stroke style');
  }
  checkIcons(p, 'landing');
  assert.ok(p.$('#signin-top use[href="#i-log-in"]') && p.$('#signout use[href="#i-log-out"]'), 'sign in and sign out icons');
  assert.ok(p.$$('#involved .ic-chip').length === 3 && p.$$('#involved .ic-chip').every(i => i.tagName === 'I'), 'the three get-involved cards have an icon chip (an <i>, not a span)');
  assert.ok(!p.$('#join > svg'), 'the Join us watermark is drawn by CSS, so every svg in #join is an icon');
  assert.ok(p.$$('#nextup a .meta use[href="#i-calendar"]').length >= 1 && p.$$('#nextup a .meta use[href="#i-map-pin"]').length >= 1, 'when and where on the event cards');
  assert.ok(p.$('#nextstrip .nsgo use[href="#i-arrow-right"]'), 'the Next up strip has an arrow on Details');
  for (const id of ['vj-err', 'si-err', 'ap-err']) assert.equal(p.$('#' + id).getAttribute('role'), 'alert', id + ' is announced');

  // an error message keeps its words when the script sets them (the warning icon is CSS)
  p.$('#joinf button[type=submit]').click();
  assert.equal(p.$('#vj-err').textContent, 'Add your name so we know who to welcome.');

  await signIn(p, 'Jessie');
  checkIcons(p, 'events');
  assert.deepEqual(p.$$('.tabs a').filter(p.visible).map(a => a.querySelector('use').getAttribute('href')), ['#i-calendar', '#i-users', '#i-image', '#i-help-circle']);
  assert.ok(p.$('#attn use[href="#i-send"]'), 'the attention bar is marked as posts to send');
  p.$('#tiles [data-open="w7"]').click();
  await waitFor(() => p.$('#detail #dp-plan'), 2000, 'Workday #7 to open');
  checkIcons(p, 'event plan');
  assert.deepEqual(p.$$('#detail .dh .fact use').map(u => u.getAttribute('href')), ['#i-calendar', '#i-clock', '#i-map-pin', '#i-out']);
  assert.deepEqual(p.$$('#detail .fold').map(f => f.querySelector('use')?.getAttribute('href')), ['#i-users', '#i-list-ordered', '#i-package', '#i-history']);
  assert.ok(p.$$('#detail [data-tdel]').every(b => b.querySelector('use[href="#i-x"]') && /^Remove /.test(b.getAttribute('aria-label'))), 'remove buttons: an x icon and a label');
  p.$('#detail [data-dtab="outreach"]').click();
  p.$('#dp-out [data-act=toggle]').click();
  checkIcons(p, 'outreach');
  const approve = p.$$('#dp-out [data-act=approve]');
  assert.ok(approve.length && approve.every(b => b.querySelector('use[href="#i-check"]')), 'Approve buttons have a check');
  p.$('#detail [data-dtab="plan"]').click();
  p.$('#edit-ev').click();
  await waitFor(() => p.$('#editf'), 2000, 'the edit form');
  checkIcons(p, 'edit form');
  assert.equal(p.$('#ed-err').getAttribute('role'), 'alert');
  assert.ok(p.$('#editf [data-cancel] use[href="#i-x"]') && p.$('#editf button[type=submit] use[href="#i-check"]'), 'Cancel and Save icons');
  p.$('#editf [data-cancel]').click();
  p.$('#m-x').click();

  p.$('.tabs a[data-tab=team]').click();
  checkIcons(p, 'team');
  assert.ok(p.$$('#team-tbl [data-rm]').every(b => b.getAttribute('aria-label') === 'Remove ' + b.closest('tr').querySelector('b').textContent), 'Remove names the person');
  // toasts with an icon still show the words as plain text
  p.set('#ap-name', 'Sam <b>Lee</b>');
  p.set('#ap-contact', 'sam.lee@example.org');
  p.$('#addp button[type=submit]').click();
  const toast = p.$('#toast');
  await waitFor(() => toast.textContent === 'Sam <b>Lee</b> added as volunteer', 3000, 'the added toast once the team is saved');
  assert.ok(p.g.tab('Team').some(r => r[0] === 'Sam <b>Lee</b>'), 'the toast came after the Team tab had the new person');
  assert.ok(toast.querySelector('use[href="#i-check"]') && !toast.querySelector('b'), 'a check icon, and the name is not HTML');
  assert.ok(p.$('#team-tbl use[href="#i-mail"]'), 'an email contact gets a mail icon');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('the event pop-up: Close has an x icon, the page behind is inert, Tab stays inside, focus comes back', async t => {
  const p = await openPage(t);
  await signIn(p);
  const tile = p.$('#tiles [data-open="w7"]');
  tile.focus();
  tile.click();
  await waitFor(() => p.$('#detail #dp-plan'), 2000, 'the pop-up');
  const close = p.$('#m-x');
  assert.ok(close.querySelector('svg.ic use[href="#i-x"]'), 'the Close button shows an x');
  assert.equal(close.textContent, 'Close');
  assert.ok(p.$('main').hasAttribute('inert') && p.$('header.top').hasAttribute('inert'), 'the page behind is inert');
  const box = p.$('#modal .mbox');
  const focusable = [...box.querySelectorAll('a[href], button, input, select, textarea')].filter(el => !el.disabled && !el.closest('[hidden]'));
  const first = focusable[0], last = focusable.at(-1);
  const tab = (el, shiftKey = false) => el.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
  last.focus(); tab(last);
  assert.equal(p.d.activeElement, first, 'Tab on the last control wraps to the first');
  first.focus(); tab(first, true);
  assert.equal(p.d.activeElement, last, 'Shift+Tab on the first control wraps to the last');
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!p.shown('#modal'), 'Escape closes it');
  assert.ok(!p.$('main').hasAttribute('inert') && !p.$('header.top').hasAttribute('inert'), 'the page is usable again');
  assert.equal(p.d.activeElement.dataset.open, 'w7', 'focus is back on the event tile');
  p.noErrors();
});

/* ---------- the prototype artifact keeps working ---------- */
test('the prototype artifact still runs with its own sign-in, Viewing as, architecture page and simulated posts', async t => {
  const p = loadPage(t, ARTIFACT, 'http://localhost/artifact');
  await waitFor(() => p.shown('#p-landing'), 2000, 'the artifact landing page');
  assert.ok(p.d.body.classList.contains('out'));
  p.$('#signin-top').click();
  assert.ok(p.visible('#si-google'), 'Continue with Google');
  assert.ok(!p.visible('#si-codew') && !p.visible('#si-then'), 'no organizer code field in the artifact');
  assert.match(p.$('#p-signin').textContent, /Prototype sign-in\. No password, nothing is saved\./);
  p.$('#si-google').click();
  assert.ok(p.visible('#p-events') && !p.d.body.classList.contains('out'), 'signed in');
  assert.ok(!p.visible('#who'), 'the artifact keeps its Viewing as select instead of the chip');
  assert.deepEqual(p.$$('.tabs a').filter(p.visible).map(a => a.textContent), ['Events', 'Team', 'Flyers & posts', "How we'd build it"]);
  assert.deepEqual(p.$$('#as option').map(o => o.textContent), ['Jessie', 'Phil', 'Kalynn', 'Sky']);
  assert.ok(p.$$('.sample').filter(p.visible).length >= 1, 'the sample badges');

  p.$('.tabs a[data-tab=architecture]').click();
  assert.ok(p.visible('#p-architecture') && p.visible('#opt-a') && !p.visible('#opt-b'));
  p.$('[data-opt=b]').click();
  assert.ok(p.visible('#opt-b') && !p.visible('#opt-a'), 'the build options switch');

  p.$('.tabs a[data-tab=events]').click();
  p.$('#tiles [data-open="w7"]').click();
  p.$('#detail [data-dtab="outreach"]').click();
  assert.ok(!p.$('#dp-out [data-act=post]'), 'nothing can be posted before it is approved');
  p.$('#dp-out [data-act=approve][data-ch=ggroup]').click();
  assert.equal(p.$('#dp-out [data-row=ggroup] .pill').textContent, 'Approved by Jessie');
  p.$('#dp-out [data-act=post][data-ch=ggroup]').click();
  await waitFor(() => p.api.toasts.includes('Posted to Google Group email (simulated)'), 2000, 'the simulated post');
  assert.match(p.$('#dp-out [data-row=ggroup] .pill').textContent, /^Posted by Jessie · \w{3} \d{1,2}$/);
  p.$('#m-x').click();

  p.set('#as', 'Kalynn');
  await waitFor(() => p.api.toasts.includes('Viewing as Kalynn'), 2000, 'the Viewing as toast');
  p.$('#tiles [data-open="w7"]').click();
  assert.equal(p.$('#detail #perm-note').textContent, "You can't approve posts or manage the team. Ask Jessie if you need to.");
  p.$('#detail [data-dtab="outreach"]').click();
  assert.ok(p.$$('#dp-out [data-act=approve]').every(b => b.disabled), 'Kalynn cannot approve');
  assert.deepEqual(p.api.calls, [], 'the artifact calls no server');
  p.noErrors();
});

/* ---------- hand edits the app can't read, and tags typed into the Sheet ---------- */
test("a date the app can't read shows a dismissible note; a tag typed into the Sheet shows as typed and survives an edit", async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  assert.equal(p.$$('#probs .probnote').length, 0, 'no notes while the Sheet is fine');

  // two hand edits in the Sheet: a date that isn't one, and a tag of the organizer's own
  const head = p.g.tab('Events')[0], rowOf = id => p.g.tab('Events').findIndex(r => r[0] === id) + 1, sh = p.g.sheets.get('Events');
  const m2 = rowOf('m2');
  sh.set(m2, head.indexOf('date') + 1, 'the Thursday after');
  sh.set(rowOf('w7'), head.indexOf('tags') + 1, 'beginner, Bring a hat');
  sh.set(rowOf('w7'), head.indexOf('date') + 1, 'Oct 31, 2026');
  p.$('#signout').click();
  await signIn(p, 'Jessie');

  const notes = p.$$('#probs .probnote');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].textContent, `Fix in the Sheet: Events row ${m2}, date "the Thursday after" not understood.`);
  assert.ok(!p.$('#tiles [data-open="m2"]'), 'the event with the unreadable date is left out');
  checkIcons(p, 'the problem note');
  const x = notes[0].querySelector('button');
  assert.equal(x.getAttribute('aria-label'), `Dismiss the note about Events row ${m2}`);
  x.click();
  assert.equal(p.$$('#probs .probnote').length, 0, 'dismissed');
  assert.equal(p.d.activeElement, p.$('#new-ev'), 'focus moves on to the next thing');

  // the tag shows as typed on the flyer, the story and the plan, never "undefined"
  const tile = p.$('#tiles [data-open="w7"]');
  assert.equal(tile.querySelector('.cal').textContent, 'OCT31', "the date typed as 'Oct 31, 2026' shows as Oct 31");
  assert.deepEqual(p.$$('#tiles [data-open="w7"] .flyer .tags span').map(s => s.textContent), ['No experience needed', 'Bring a hat']);
  assert.match(tile.querySelector('.story .ft p').textContent, /^No experience needed\. Bring a hat\.$/);
  tile.click();
  await waitFor(() => p.$('#detail #dp-plan'), 2000, 'Workday #7 to open');
  assert.deepEqual(p.$$('#detail span.tag').map(s => s.textContent), ['Beginner friendly', 'Bring a hat']);
  assert.ok(!/undefined/.test(p.$('#detail').textContent + p.$('#tiles').textContent));

  // editing the event keeps the typed tag in the Sheet
  p.$('#edit-ev').click();
  await waitFor(() => p.$('#editf #ed-title'), 2000, 'the edit form');
  p.set('#ed-title', 'Fall Planting Work Party');
  p.$('#editf button[type=submit]').click();
  await waitFor(() => (p.g.tab('Events').find(r => r[0] === 'w7') || [])[2] === 'Fall Planting Work Party', 3000, 'the save');
  assert.equal(p.g.tab('Events').find(r => r[0] === 'w7')[head.indexOf('tags')], 'beginner, Bring a hat');
  assert.equal(p.g.tab('Events')[m2 - 1][head.indexOf('date')], 'the Thursday after', 'the row to fix is left as typed');
  await waitFor(p.idle, 2000, 'saves to finish');
  p.noErrors();
});

/* ---------- saving: the status chip, retries, ordered saves, refresh and sign-in progress ---------- */
const NO_ANSWER = "The Guild Sheet didn't answer. We'll keep trying.";
const chipText = p => p.$('#savest-t').textContent;
const rowOf = (p, id) => p.g.tab('Events').find(r => r[0] === id) || [];
const titleCol = p => p.g.tab('Events')[0].indexOf('title');
/* open an event's edit form, type a title and press Save (the pop-up stays open, so a second edit reuses it) */
async function editTitle(p, id, title) {
  if (!p.shown('#modal')) p.$(`#tiles [data-open="${id}"]`).click();
  (await waitFor(() => p.$('#detail #edit-ev'), 2000, 'the event to open')).click();
  await waitFor(() => p.$('#editf #ed-title'), 2000, 'the edit form');
  p.set('#ed-title', title);
  p.$('#editf button[type=submit]').click();
  await waitFor(() => !p.$('#editf'), 2000, 'the edit form to close');
}
const unloadWarns = p => { const e = new p.w.Event('beforeunload', { cancelable: true }); p.w.dispatchEvent(e); return e.defaultPrevented; };

test('saving: the chip says Saving…, then All changes saved, then fades; "Saved" waits for the Sheet', async t => {
  const p = await openPage(t);
  await signIn(p);
  const chip = p.$('#savest');
  assert.equal(chip.getAttribute('role'), 'status');
  assert.ok(chip.closest('header.top'), 'the chip is in the top bar');
  assert.equal(chip.dataset.state, 'idle');
  assert.equal(chipText(p), '', 'nothing to say right after sign-in');
  assert.ok(!unloadWarns(p), 'nothing to warn about');

  p.api.latency = 600;
  await editTitle(p, 'w7', 'Fall Planting Work Party');
  assert.equal(chip.dataset.state, 'saving');
  assert.equal(chipText(p), 'Saving…');
  assert.ok(chip.querySelector('use[href="#i-loader"]'), 'with the loader icon');
  assert.ok(p.$('#savest-retry').hidden, 'no Retry while saving');
  assert.ok(unloadWarns(p), 'closing the tab now warns: the save is still going');
  await waitFor(() => p.api.out.saveEvent === 1, 3000, 'the save to go out');
  assert.equal(chipText(p), 'Saving…');
  assert.ok(!p.api.toasts.includes('Saved'), '"Saved" waits for the Sheet');

  await waitFor(() => chipText(p) === 'All changes saved', 3000, 'All changes saved');
  assert.equal(rowOf(p, 'w7')[titleCol(p)], 'Fall Planting Work Party', 'the Sheet has it');
  assert.ok(chip.querySelector('use[href="#i-check"]'));
  assert.equal(p.api.toasts.at(-1), 'Saved', 'the Saved toast came once the Sheet confirmed');
  assert.ok(!unloadWarns(p), 'nothing left to warn about');
  await waitFor(() => chip.classList.contains('fade'), 4500, 'the chip to fade after 3 s');
  await waitFor(() => chip.dataset.state === 'idle' && chipText(p) === '', 2000, 'the chip to clear');
  p.noErrors();
});

test("a save that fails: Not saved with Retry, a mark on the tile, a warning on close, and it saves once the Sheet answers", async t => {
  const p = await openPage(t);
  await signIn(p);
  p.api.fail = 'saveEvent';
  await editTitle(p, 'w7', 'Rain Plan Work Party');
  p.$('#m-x').click();
  const chip = p.$('#savest'), retry = p.$('#savest-retry');
  await waitFor(() => chip.dataset.state === 'failed', 3000, 'Not saved');
  assert.equal(chipText(p), 'Not saved');
  assert.ok(!retry.hidden && retry.textContent === 'Retry' && retry.querySelector('use[href="#i-rotate-ccw"]'), 'a Retry button');
  assert.ok(p.api.toasts.includes(NO_ANSWER), 'the toast says the Sheet did not answer');
  assert.ok(![...p.api.toasts, ...p.api.errors].some(s => /Unexpected token|JSON/.test(s)), 'never "Unexpected token"');
  assert.ok(!p.api.toasts.includes('Saved'), 'no "Saved" for a save that failed');
  assert.notEqual(rowOf(p, 'w7')[titleCol(p)], 'Rain Plan Work Party');

  const tile = p.$('#tiles [data-open="w7"]');
  assert.ok(tile.classList.contains('unsaved') && p.visible(tile.querySelector('.nsave')), 'the tile shows Not saved');
  assert.equal(tile.querySelector('.nsave').textContent, 'Not saved');
  assert.match(tile.getAttribute('aria-label'), /\. Changes not saved yet$/, 'and says so to screen readers');
  assert.ok(!p.$('#tiles [data-open="m2"]').classList.contains('unsaved'), 'other events are not marked');
  assert.ok(unloadWarns(p), 'closing the tab asks first');

  // it keeps trying on its own (2 s, 5 s, 15 s, then every minute)
  const tries = () => p.api.sent.filter(c => c.fn === 'saveEvent').length, first = tries();
  await waitFor(() => tries() > first, 3500, 'an automatic retry');
  await waitFor(p.idle, 2000, 'the retry to come back');
  assert.equal(chipText(p), 'Not saved', 'still not saved while the Sheet fails');
  assert.equal(p.api.toasts.filter(s => s === NO_ANSWER).length, 1, 'the failure toast is not repeated on every retry');

  // the Sheet answers again; Retry sends it now
  p.api.fail = '';
  p.api.latency = 300;
  retry.focus();
  retry.click();
  assert.equal(chipText(p), 'Saving…', 'Retry shows Saving…');
  assert.equal(p.d.activeElement, chip, 'focus stays on the chip while it retries');
  await waitFor(() => chipText(p) === 'All changes saved', 3000, 'All changes saved');
  assert.equal(rowOf(p, 'w7')[titleCol(p)], 'Rain Plan Work Party', 'the Sheet has the edit');
  assert.ok(!p.$('#tiles [data-open="w7"]').classList.contains('unsaved'), 'the tile mark is gone');
  assert.doesNotMatch(p.$('#tiles [data-open="w7"]').getAttribute('aria-label'), /not saved/);
  assert.ok(!unloadWarns(p), 'nothing to warn about now');
  assert.deepEqual(p.api.errors, [], 'no script errors');
});

test('two quick edits go out one at a time, the newest last', async t => {
  const p = await openPage(t);
  await signIn(p);
  p.api.latency = 1200;
  await editTitle(p, 'w7', 'First Title');
  await waitFor(() => p.api.out.saveEvent === 1, 3000, 'the first save to go out');
  await editTitle(p, 'w7', 'Second Title');
  await waitFor(() => chipText(p) === 'All changes saved', 6000, 'both saves');
  const saves = p.api.sent.filter(c => c.fn === 'saveEvent');
  assert.equal(p.api.most.saveEvent, 1, 'never two saves of the event at once');
  assert.deepEqual(saves.map(s => s.args[1].cols.title), ['First Title', 'Second Title'], 'in order, and only the newest after the first');
  assert.equal(rowOf(p, 'w7')[titleCol(p)], 'Second Title');
  p.noErrors();
});

test("an HTML error page during sign-in reads as the Sheet not answering, and picking a name again works", async t => {
  const p = await openPage(t, null, await seededSheet(t));
  p.api.fail = 'signIn';
  await startSignIn(p, p.code(), 'Phil');
  const err = await waitFor(() => p.shown('#si-err') && p.$('#si-err'), 3000, 'the sign-in error');
  assert.equal(err.textContent, "The Guild Sheet didn't answer. Check your internet, then pick your name to try again.");
  assert.ok(!p.$$('#si-pick button').some(b => b.disabled || b.getAttribute('aria-busy')), 'the names work again');
  assert.equal(p.$('#si-wait').textContent, '', 'the waking-up line is gone');
  p.api.fail = '';
  p.$('#si-pick button[data-as="Phil"]').click();
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 4000, 'the events page');
  assert.ok(![...p.api.toasts, ...p.api.errors].some(s => /Unexpected token/.test(s)));
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.deepEqual(p.api.errors, []);
});

test('sign-in shows Signing in… on the name and a waking-up line; the device is remembered only when asked', async t => {
  const p = await openPage(t, null, await seededSheet(t));
  p.api.latency = 300;
  await startSignIn(p, p.code(), 'Phil');
  const btn = p.$('#si-pick button[data-as="Phil"]');
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  assert.match(btn.textContent, /^P?Phil\s*Signing in…$/);
  assert.equal(p.d.activeElement === btn || !btn.disabled, true, 'the clicked name keeps focus (it is not disabled)');
  assert.ok(p.$$('#si-pick button').filter(b => b !== btn).every(b => b.disabled), 'the other names wait');
  const wait = p.$('#si-wait');
  assert.equal(wait.getAttribute('role'), 'status');
  assert.equal(wait.textContent, 'Waking up the Guild Sheet. This can take a few seconds.');
  assert.ok(p.visible(wait));
  btn.click(); // a second click while it works does nothing
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 4000, 'the events page');
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.equal(p.api.calls.filter(c => c === 'signIn').length, 1, 'one sign-in call');
  assert.equal(p.$('#si-wait').textContent, '');
  assert.equal(p.w.sessionStorage.getItem('ebpg-code'), p.code(), 'this tab keeps the code');
  assert.equal(p.w.localStorage.getItem('ebpg-remember'), null, 'the device does not, unless asked');

  p.$('#signout').click();
  assert.equal(p.w.sessionStorage.getItem('ebpg-code'), null, 'signing out forgets the code');
  p.$('#signin-top').click();
  p.set('#si-code', p.code());
  p.$('#si-rem').click();
  assert.equal(p.$('#si-rem').checked, true);
  p.$('#si-pick button[data-as="Jessie"]').click();
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 4000, 'the events page');
  const kept = JSON.parse(p.w.localStorage.getItem('ebpg-remember'));
  assert.equal(kept.code, p.code());
  assert.equal(kept.name, 'Jessie');
  assert.ok(Math.abs(kept.until - (p.w.Date.now() + 30 * 864e5)) < 60000, 'for 30 days');
  p.$('#signout').click();
  assert.equal(p.w.localStorage.getItem('ebpg-remember'), null, 'signing out forgets the device too');
  assert.equal(p.w.sessionStorage.getItem('ebpg-code'), null);
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

/* the organizer code as a reload finds it: this tab's, or this device's */
const withCode = (where, name, until) => (w, g, api) => {
  g.ctx.getPublic(); // makes the Settings tab with the organizer code
  const code = g.tab('Settings').find(r => r[0] === 'ORGANIZER_CODE')[1];
  api.latency = 150;
  if (where === 'tab') { w.sessionStorage.setItem('ebpg-code', code); w.sessionStorage.setItem('ebpg-user', name); }
  else w.localStorage.setItem('ebpg-remember', JSON.stringify({ code, name, until: w.Date.now() + until }));
};

test('a reload with the code from this tab shows "Signing you back in…", not the landing page', async t => {
  const p = loadPage(t, SITE, 'http://localhost:8766/site', withCode('tab', 'Phil'));
  assert.ok(p.shown('#p-resume') && p.visible('#p-resume'), 'the signing-back-in card');
  assert.match(p.$('#p-resume').textContent, /Signing you back in…/);
  assert.match(p.$('#p-resume').textContent, /Waking up the Guild Sheet\. This can take a few seconds\./);
  assert.equal(p.$('#p-resume .scard').getAttribute('role'), 'status');
  assert.ok(!p.shown('#p-landing') && !p.shown('#p-signin'), 'not the landing page');
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 4000, 'the events page');
  assert.ok(!p.shown('#p-resume'));
  assert.equal(p.$('#who > span:last-child').textContent, 'Signed in as Phil · Co-organizer');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('a device remembered for 30 days signs back in; an expired one goes to the landing page', async t => {
  const p = loadPage(t, SITE, 'http://localhost:8766/site', withCode('device', 'Kalynn', 864e5));
  assert.ok(p.shown('#p-resume'), 'the signing-back-in card');
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 4000, 'the events page');
  assert.equal(p.$('#who > span:last-child').textContent, 'Signed in as Kalynn · Co-organizer');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();

  const old = loadPage(t, SITE, 'http://localhost:8766/site', withCode('device', 'Kalynn', -1000));
  assert.ok(old.shown('#p-landing') && !old.shown('#p-resume'), 'an expired code is not used');
  assert.equal(old.w.localStorage.getItem('ebpg-remember'), null, 'and is thrown away');
  await waitFor(old.idle, 2000, 'calls to finish');
  assert.ok(!old.api.calls.includes('signIn'));
});

test('coming back to the tab picks up changes from the Sheet, but not over unsaved or half-typed changes', async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  const sh = p.g.sheets.get('Events'), col = titleCol(p) + 1, at = id => p.g.tab('Events').findIndex(r => r[0] === id) + 1;
  // m2 has a change here that can't reach the Sheet
  p.api.fail = 'saveEvent';
  await editTitle(p, 'm2', 'Winter Potluck');
  p.$('#m-x').click();
  await waitFor(() => p.$('#savest').dataset.state === 'failed', 3000, 'Not saved');
  // w6 is open with a title half typed
  p.$('[data-when="past"]').click();
  p.$('#tiles [data-open="w6"]').click();
  (await waitFor(() => p.$('#detail #edit-ev'), 2000, 'w6 to open')).click();
  await waitFor(() => p.$('#editf #ed-title'), 2000, 'the edit form');
  p.set('#ed-title', 'Typing a new na');
  // meanwhile, someone changes all three in the Sheet, and a contact on the Team tab
  sh.set(at('w7'), col, 'Bulb Planting Work Party');
  sh.set(at('m2'), col, 'Changed in the Sheet');
  sh.set(at('w6'), col, 'Also changed in the Sheet');
  const team = p.g.sheets.get('Team'), phil = p.g.tab('Team').findIndex(r => r[0] === 'Phil') + 1;
  team.set(phil, p.g.tab('Team')[0].indexOf('email or phone') + 1, 'phil@ebpg.org');

  const reads = () => p.api.calls.filter(c => c === 'signIn').length, before = reads();
  p.d.dispatchEvent(new p.w.Event('visibilitychange'));
  await waitFor(() => p.api.toasts.includes('Updated with the latest changes'), 3000, 'the updated toast');
  assert.equal(reads(), before + 1, 'read the Sheet once');
  assert.equal(p.$('#ed-title').value, 'Typing a new na', 'the half-typed title is untouched');
  assert.ok(p.$('#editf'), 'the edit form is still open');
  p.$('#editf [data-cancel]').click();
  p.$('#m-x').click();
  p.$('[data-when="up"]').click();
  assert.equal(p.$('#tiles [data-open="w7"] h3').textContent, 'Bulb Planting Work Party', 'the Sheet change shows');
  assert.equal(p.$('#tiles [data-open="m2"] h3').textContent, 'Winter Potluck', 'the unsaved change here is kept');
  assert.ok(p.$('#tiles [data-open="m2"]').classList.contains('unsaved'));
  p.$('.tabs a[data-tab=team]').click();
  assert.match(p.$('#team-tbl').textContent, /phil@ebpg\.org/, 'the team picks up the new contact');

  // a second return right away doesn't read again
  p.d.dispatchEvent(new p.w.Event('visibilitychange'));
  await sleep(50);
  assert.equal(reads(), before + 1, 'no second read within a few seconds');
  assert.deepEqual(p.api.errors, []);
});

test("this page's own save coming back from the Sheet is not news", async t => {
  const p = await openPage(t);
  await signIn(p);
  await editTitle(p, 'w7', 'Fall Planting Work Party');
  p.$('#m-x').click();
  await waitFor(() => chipText(p) === 'All changes saved', 3000, 'the save');
  const reads = () => p.api.done.filter(c => c.fn === 'signIn').length, before = reads();
  p.d.dispatchEvent(new p.w.Event('visibilitychange'));
  await waitFor(() => reads() === before + 1 && p.idle(), 3000, 'the Sheet to be read again');
  await sleep(20);
  assert.ok(!p.api.toasts.includes('Updated with the latest changes'), 'no "Updated" toast');
  assert.equal(p.$('#tiles [data-open="w7"] h3').textContent, 'Fall Planting Work Party');
  assert.ok(!p.api.sent.slice(-1).some(c => c.fn === 'saveEvent'), 'reading it back does not save it again');
  p.noErrors();
});

test('a save that fails with the event pop-up open: the pop-up shows Not saved with a Retry that works', async t => {
  const p = await openPage(t);
  await signIn(p);
  p.api.fail = 'saveEvent';
  await editTitle(p, 'w7', 'Rain Plan Work Party');
  const chip = p.$('#m-savest'), retry = chip.querySelector('button'), say = () => chip.firstElementChild.textContent;
  await waitFor(() => chip.dataset.state === 'failed', 3000, 'Not saved in the pop-up');
  assert.ok(p.shown('#modal') && p.$('header.top').hasAttribute('inert'), 'the pop-up is still open over an inert page');
  assert.ok(p.$('#modal .mbar').contains(chip) && !chip.closest('[inert]') && p.visible(chip), "in the pop-up's bar, outside the inert page");
  assert.ok(!chip.contains(p.$('#m-x')) && p.visible('#m-x'), 'Close is still there');
  assert.equal(chip.getAttribute('role'), 'status');
  assert.equal(say(), 'Not saved');
  assert.ok(chip.querySelector('use[href="#i-alert-triangle"]'));
  assert.ok(!retry.hidden && p.visible(retry) && retry.textContent === 'Retry' && retry.querySelector('use[href="#i-rotate-ccw"]'), 'a Retry button');
  assert.equal(p.$('#savest').dataset.state, 'failed', 'the top bar chip agrees, for when the pop-up closes');

  // a second Save while it's failing tries again at once and says how it went
  p.api.latency = 400;
  await editTitle(p, 'w7', 'Rain Plan Work Party, take two');
  assert.equal(say(), 'Saving…', 'Save shows Saving… again');
  await waitFor(() => say() === 'Not saved', 3000, 'Not saved again');

  // the Sheet answers again; Retry in the pop-up sends it and leaves the pop-up open
  p.api.fail = '';
  retry.focus();
  retry.click();
  assert.equal(say(), 'Saving…');
  assert.equal(p.d.activeElement, chip, 'focus stays on the note in the pop-up while it retries');
  await waitFor(() => say() === 'All changes saved', 3000, 'All changes saved');
  assert.ok(p.shown('#modal'), 'the pop-up stays open');
  assert.equal(rowOf(p, 'w7')[titleCol(p)], 'Rain Plan Work Party, take two', 'the Sheet has the newest edit');
  await waitFor(p.idle, 2000, 'saves to finish');
  assert.deepEqual(p.api.errors, []);
});

test('Signing in… stays on the name when the public events arrive while it signs in', async t => {
  // the names on show are the last visit's (kept on this device); the public read is still out when one is picked,
  // and comes back before the sign-in does. The Sheet was emptied since (resetStarterData), so it gets filled first.
  const p = loadPage(t, SITE, 'http://localhost:8766/site', (w, g, api) => {
    const sheet = g.ctx.getPublic(); // makes the Settings tab with the organizer code
    w.localStorage.setItem('ebpg-public-v1', JSON.stringify({ at: 0, st: { ...sheet, team: [{ name: 'Jessie', role: 'lead' }, { name: 'Phil', role: 'co' }] } }));
    api.latency = 300;
  });
  p.api.latency = 1500;
  p.$('#signin-top').click();
  p.set('#si-code', p.code());
  const pick = p.$('#si-pick button[data-as="Jessie"]');
  pick.focus();
  pick.click();
  assert.equal(pick.getAttribute('aria-busy'), 'true');
  p.api.latency = 500; // for the seed that follows
  await waitFor(() => !pick.isConnected && p.api.done.some(c => c.fn === 'getPublic'), 3000, 'the picker to be redrawn with what the Sheet has');
  // nobody on the Team tab yet, so the redrawn picker offers Continue, which waits too
  assert.deepEqual(p.$$('#si-pick button').map(b => [b.dataset.as, b.disabled]), [['', true]]);
  assert.ok(!p.api.done.some(c => c.fn === 'signIn'), 'the sign-in is still going');
  assert.equal(p.$('#si-wait').textContent, 'Waking up the Guild Sheet. This can take a few seconds.');
  // an empty Sheet gets filled first, and the line says so
  await waitFor(() => p.api.out.seed === 1, 3000, 'the Sheet to be filled');
  assert.equal(p.$('#si-wait').textContent, 'Setting up the Guild Sheet for the first time. This can take up to a minute.');
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 4000, 'the events page');
  assert.equal(p.$('#who > span:last-child').textContent, 'Signed in as Jessie · Lead organizer');
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.deepEqual(p.api.calls.filter(c => c === 'signIn' || c === 'seed'), ['signIn', 'seed'], 'one sign-in call');
  p.noErrors();
});

test('Signing in… stays on the name when the Sheet\'s names replace the ones kept from the last visit', async t => {
  const p = loadPage(t, SITE, 'http://localhost:8766/site', (w, g, api) => {
    w.localStorage.setItem('ebpg-public-v1', JSON.stringify({ at: 0, st: g.ctx.getPublic() }));
    api.latency = 300;
  }, await seededSheet(t));
  p.api.latency = 1500;
  p.$('#signin-top').click();
  p.set('#si-code', p.code());
  const pick = p.$('#si-pick button[data-as="Jessie"]');
  pick.focus();
  pick.click();
  assert.equal(pick.getAttribute('aria-busy'), 'true');
  await waitFor(() => !pick.isConnected, 3000, 'the picker to be redrawn with what the Sheet has');
  assert.ok(!p.api.done.some(c => c.fn === 'signIn'), 'the sign-in is still going');
  const btn = p.$('#si-pick button[data-as="Jessie"]');
  assert.equal(btn.getAttribute('aria-busy'), 'true', 'the redrawn name is still busy');
  assert.match(btn.textContent, /Jessie\s*Signing in…$/);
  assert.ok(!btn.disabled && p.d.activeElement === btn, 'and keeps keyboard focus');
  assert.ok(p.$$('#si-pick button').filter(b => b !== btn).every(b => b.disabled), 'the other names still wait');
  assert.equal(p.$('#si-wait').textContent, 'Waking up the Guild Sheet. This can take a few seconds.');
  btn.click(); // still does nothing while it works
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 4000, 'the events page');
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.equal(p.api.calls.filter(c => c === 'signIn').length, 1, 'one sign-in call');
  assert.ok(!p.api.calls.includes('seed'), 'the Sheet was set up already');
  assert.ok(p.$$('#si-pick button').every(b => !b.disabled && !b.hasAttribute('aria-busy')), 'the names are back to normal');
  assert.ok(!p.$$('#si-pick small').some(s => /Signing in/.test(s.textContent)));
  assert.equal(p.$('#si-wait').textContent, '');
  p.noErrors();
});

test('a remembered device stays remembered when signing back in fails and the name is picked again', async t => {
  const p = loadPage(t, SITE, 'http://localhost:8766/site', (w, g, api) => { withCode('device', 'Kalynn', 864e5)(w, g, api); api.fail = 'signIn'; }, await seededSheet(t));
  assert.ok(p.shown('#p-resume'), 'the signing-back-in card');
  await waitFor(() => p.shown('#p-signin') && p.shown('#si-err'), 3000, 'the sign-in card after the Sheet did not answer');
  assert.equal(p.$('#si-rem').checked, true, 'Remember this device is still ticked');
  p.api.fail = '';
  p.$('#si-pick button[data-as="Kalynn"]').click();
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 4000, 'the events page');
  const kept = JSON.parse(p.w.localStorage.getItem('ebpg-remember'));
  assert.equal(kept && kept.code, p.code(), 'the device still has the code');
  p.$('#signout').click();
  assert.equal(p.w.localStorage.getItem('ebpg-remember'), null, 'signing out forgets the device');
  assert.equal(p.$('#si-rem').checked, false, 'and unticks the box for whoever signs in next');
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.deepEqual(p.api.errors, []);
});

test('coming back to the tab retries a failed save right away, without waiting for the next retry', async t => {
  const p = await openPage(t);
  await signIn(p);
  p.api.fail = 'saveEvent';
  await editTitle(p, 'w7', 'Rain Plan Work Party');
  p.$('#m-x').click();
  await waitFor(() => p.$('#savest').dataset.state === 'failed', 3000, 'Not saved');
  p.api.fail = '';
  p.d.dispatchEvent(new p.w.Event('visibilitychange'));
  // the next retry on its own is 2 s away
  await waitFor(() => chipText(p) === 'All changes saved', 1000, 'All changes saved soon after coming back');
  assert.equal(rowOf(p, 'w7')[titleCol(p)], 'Rain Plan Work Party');
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.deepEqual(p.api.errors, []);
});

test('signing in gets 45 seconds and filling an empty Sheet 90; other calls get 30', async t => {
  const p = await openPage(t, (w, g, api) => {
    const later = w.setTimeout;
    api.limits = [];
    w.setTimeout = (f, ms, ...a) => { if (ms >= 30000) api.limits.push(ms); return later.call(w, f, ms, ...a); };
  });
  assert.deepEqual(p.api.limits, [30000], 'the public read');
  await signIn(p);
  assert.ok(p.api.calls.includes('seed'));
  assert.deepEqual(p.api.limits.slice(0, 3), [30000, 45000, 90000], 'getPublic, signIn, seed');
  p.noErrors();
});

test('the status chip and the Not saved mark are live-only: the artifact never shows them', () => {
  const src = fs.readFileSync(ARTIFACT, 'utf8');
  assert.match(src, /<div class="savest live" id="savest" role="status"/);
  assert.match(src, /<div class="savest live" id="m-savest" role="status"/);
  assert.match(src, /<label class="chk live" id="si-remw">/);
  assert.match(src, /<div id="p-resume" data-page="resume" class="signin live" hidden>/);
});

/* ---------- server hardening: the test-mode banner, and Sheet values that try to become page markup ---------- */
test('in test mode organizers see a lemon banner naming who gets every email, with a link to the Sheet; it goes when test mode is off', async t => {
  const p = await openPage(t);
  assert.ok(!p.visible('#testbar'), 'no banner on the public page');
  await signIn(p, 'Jessie');
  const bar = p.$('#testbar');
  assert.ok(p.visible(bar), 'the banner is shown');
  assert.equal(bar.getAttribute('role'), 'note');
  assert.equal(bar.querySelector('.grow').textContent, "Test mode: every email goes only to owner@example.com. Turn it off on the Settings tab when you're ready to go live.");
  const link = bar.querySelector('a');
  assert.equal(link.textContent, 'Open the Sheet');
  assert.equal(link.href, 'https://docs.google.com/spreadsheets/d/sheet-1/edit');
  assert.deepEqual([link.target, link.rel], ['_blank', 'noopener']);
  for (const tab of ['team', 'materials', 'help', 'events']) {
    p.$(`.tabs a[data-tab=${tab}]`).click();
    assert.ok(p.visible(bar), 'still shown on ' + tab);
  }
  p.$('#tiles [data-open]').click();
  assert.ok(p.visible(bar), 'and behind an open event');
  p.$('#m-x').click();
  checkIcons(p, 'the test-mode banner');

  // turned off on the Settings tab: gone on the next read of the Sheet
  const s = p.g.sheets.get('Settings'), row = p.g.tab('Settings').findIndex(r => r[0] === 'TEST_MODE') + 1;
  s.set(row, 2, 'FALSE');
  const reads = p.api.calls.filter(c => c === 'signIn').length;
  p.d.dispatchEvent(new p.w.Event('visibilitychange'));
  await waitFor(() => p.api.calls.filter(c => c === 'signIn').length > reads && p.idle(), 3000, 'the Sheet to be read again');
  assert.ok(bar.hidden && !p.visible(bar), 'the banner is gone');
  // on again, then signing out hides it
  s.set(row, 2, 'TRUE');
  p.$('#signout').click();
  assert.ok(!p.visible(bar), 'hidden after signing out');
  await signIn(p, 'Phil');
  assert.ok(p.visible(bar), 'back for the next organizer');
  assert.match(fs.readFileSync(ARTIFACT, 'utf8'), /<div class="testbar live" id="testbar"/, 'the artifact never shows it');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('values typed into the Sheet never become page markup: photos, links, names, statuses, task ids and sign-ups', async t => {
  const CODE = 'garden-test-2468';
  const ev = {
    id: 'w9',
    data: { id: 'w9', series: 'workday', num: 9, label: 'Workday #9', photo: 'trellis', tags: ['beginner'], map: 'https://maps.app.goo.gl/9jQkydC38eJrRScr6', plan: { roles: [['Host', ['Jessie']]], notes: [], timeline: [] } },
    cols: { label: 'Workday #9', title: 'OPC Garden Work Party', date: '2026-10-31', start: '10:00', end: '14:00', place: 'Oakland Peace Center', address: '', host: 'Jessie', cohosts: '', about: 'Dig day.', bring: 'water', tags: 'beginner', notes: '', timeline: '', status: 'published' },
    tasks: [{ id: 't1', what: 'Plates', who: 'Jessie', status: 'asked' }],
    posts: [{ channel: 'partiful', status: 'review', by: '', text: 'Come dig', edited: false }],
    log: [],
  };
  const lead = { name: 'Jessie', role: 'lead', contact: '', via: '', perms: { create: true, edit: true, approve: true, tasks: true, team: true } };
  const p = await openPage(t, (w, g) => {
    g.ctx.doGet({});
    g.ctx.seed(CODE, { events: [ev], team: [lead, { name: 'Phil', role: 'co', contact: '', via: '', perms: {} }], vols: [], gardens: [] });
    // then someone types markup into the Sheet by hand
    const cell = (tab, row, head, v) => g.sheets.get(tab).set(row, g.tab(tab)[0].indexOf(head) + 1, v);
    const data = JSON.parse(g.tab('Events')[1][g.tab('Events')[0].indexOf("data (don't edit)")]);
    cell('Events', 2, "data (don't edit)", JSON.stringify({ ...data, photo: '"><img src=x id=pwn-photo>', map: 'javascript:alert(1)' }));
    cell('Events', 2, 'host', 'Jessie<img src=x id=pwn-host>');
    cell('Posts', 2, 'status', 'review"><img src=x id=pwn-status>');
    cell('Bringing', 2, 'task id', 't1"><img src=x id=pwn-task>');
    cell('Team', 3, 'name', 'Phil<img src=x id=pwn-team>');
    g.sheets.get('Volunteers').set(2, 1, '2026-10-20');
    ['<img src=x id=pwn-vol>', '<img src=x id=pwn-contact>@x', '<img src=x id=pwn-help>', '<img src=x id=pwn-note>'].forEach((v, i) => g.sheets.get('Volunteers').set(2, i + 2, v));
  });
  const pwned = () => p.$$('[id^=pwn]').map(el => el.id);
  const photos = () => p.$$('.photo').map(el => el.className);
  assert.deepEqual(pwned(), [], 'nothing injected on the public page');
  assert.ok(photos().length && photos().every(c => /^photo ph-(trellis|moat|pantry|none)$/.test(c)), photos().join(' | '));
  assert.ok(p.$$('#si-pick button').some(b => b.textContent.includes('Phil<img src=x id=pwn-team>')), 'the name shows as typed');

  await signIn(p, 'Jessie');
  p.$('#tiles [data-open="w9"]').click();
  await waitFor(() => p.$('#detail #dp-plan'), 2000, 'the event to open');
  assert.match(p.$('#detail [data-fold=host]').textContent, /Jessie<img src=x id=pwn-host>/, 'the host shows as typed in the Hosting count');
  assert.ok(!p.$('#detail a[href^="javascript"]') && !p.$$('#detail a').some(a => /^Map/.test(a.textContent)), 'no Map link for a javascript: URL');
  p.$('#detail [data-dtab="outreach"]').click();
  const row = await waitFor(() => p.$('#dp-out .orow'), 2000, 'the Outreach tab');
  assert.equal(row.className, 'orow review', 'an unknown status reads as a draft');
  row.querySelector('[data-act=toggle]').click();
  const ta = await waitFor(() => p.$('#dp-out textarea[data-ta=partiful]'), 2000, 'the open draft');
  assert.equal(ta.id, 'ta-w9-partiful');
  assert.equal(p.$('#dp-out .obody a').href, 'https://partiful.com/');
  const del = p.$('#detail [data-tdel]');
  assert.match(del.dataset.tdel, /^t\d+$/, 'a task id the Sheet would refuse gets a new one');
  p.$('#m-x').click();
  p.$('.tabs a[data-tab=team]').click();
  assert.match(p.$('#vol-tbl').textContent, /<img src=x id=pwn-vol>/, 'the sign-up shows as typed');
  assert.deepEqual(pwned(), [], 'nothing injected anywhere on the organizer pages');
  assert.ok(photos().every(c => /^photo ph-(trellis|moat|pantry|none)$/.test(c)));
  assert.ok(!p.$$('a[href]').some(a => /^\s*javascript:/i.test(a.getAttribute('href'))), 'no javascript: links');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test("after too many wrong codes the sign-in page says to wait, and a remembered device keeps its code for later", async t => {
  const p = loadPage(t, SITE, 'http://localhost:8766/site', (w, g, api) => {
    withCode('device', 'Kalynn', 864e5)(w, g, api);
    for (let i = 0; i < 21; i++) try { g.ctx.signIn('guess-' + i); } catch {} // someone else guessing
  }, await seededSheet(t));
  const err = await waitFor(() => p.shown('#p-signin') && p.shown('#si-err') && p.$('#si-err'), 4000, 'the sign-in card');
  assert.equal(err.textContent, 'Too many tries. Wait 10 minutes and try again.');
  assert.equal(JSON.parse(p.w.localStorage.getItem('ebpg-remember')).code, p.code(), 'the device keeps the code');
  // once the 10 minutes are up (the mock's count is cleared), the remembered code works again
  for (const k of Object.keys(p.g.cache)) if (k.startsWith('fail:')) delete p.g.cache[k];
  p.$('#si-pick button[data-as="Kalynn"]').click();
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 4000, 'the events page');
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.deepEqual(p.api.errors, []);
});

/* ---------- the organizer code changed while a page was open ---------- */
// timers run 200 times faster, so the retry schedule's ten minutes take three seconds (the 800 ms save delay stays);
// the 2-minute read of the Sheet runs when the test says, as api.tick()
const fastTimers = (w, g, api) => {
  const later = w.setTimeout, every = w.setInterval;
  w.setTimeout = (f, ms, ...a) => later.call(w, f, ms >= 1000 ? ms / 200 : ms, ...a);
  w.setInterval = (f, ms, ...a) => { if (ms === 120000) { api.tick = f; return 0; } return every.call(w, f, ms, ...a); };
};
const newCode = (p, c) => p.g.sheets.get('Settings').set(p.g.tab('Settings').findIndex(r => r[0] === 'ORGANIZER_CODE') + 1, 2, c);

test("after the organizer code changes, an open page stops sending the old one, keeps its changes, and saves them once signed in with the new code", async t => {
  const p = await openPage(t, fastTimers);
  const OLD = p.code(), NEW = 'garden-new-1357';
  await signIn(p, 'Jessie');
  assert.equal(typeof p.api.tick, 'function', 'the page reads the Sheet every 2 minutes');
  // the code is changed on the Settings tab while Jessie has the page open, and she edits two events
  newCode(p, NEW);
  const from = p.api.sent.length, oldSent = () => p.api.sent.slice(from).filter(c => c.args[0] === OLD).length;
  const wrong = () => Object.entries(p.g.cache).filter(([k]) => k.startsWith('fail:')).reduce((n, [, c]) => n + Number(c.v), 0);
  await editTitle(p, 'w7', 'Rain Plan Work Party');
  p.$('#m-x').click();
  await editTitle(p, 'm2', 'Winter Potluck');
  p.$('#m-x').click();

  // the Sheet turns the old code down once: the page asks for the new code and keeps the changes
  const STALE = 'The organizer code was changed. Sign in again with the new code, and your changes here will be saved.';
  await waitFor(() => p.shown('#p-signin') && p.shown('#si-err') && p.$('#si-err').textContent === STALE, 3000, 'the sign-in card asking for the new code');
  assert.equal(p.d.activeElement, p.$('#si-code'), 'the code field has focus');
  assert.equal(p.$('#si-code').value, '', 'and is empty');
  await waitFor(p.idle, 2000, 'calls to finish');
  const chip = p.$('#savest'), btn = p.$('#savest-retry');
  assert.equal(chip.dataset.state, 'stale');
  assert.equal(chipText(p), 'Not saved');
  assert.ok(!btn.hidden && btn.textContent === 'Sign in again' && btn.querySelector('use[href="#i-log-in"]'), 'the chip offers Sign in again');
  assert.ok(['w7', 'm2'].every(id => p.$(`#tiles [data-open="${id}"]`).classList.contains('unsaved')), 'both tiles say Not saved');
  assert.equal(p.$('#tiles [data-open="w7"] h3').textContent, 'Rain Plan Work Party', 'the change is still on the page');
  assert.ok(unloadWarns(p), 'closing the tab asks first');

  // ten minutes of retries, 2-minute reads, coming back to the tab, the connection coming back and Retry
  for (let i = 0; i < 10; i++) {
    p.api.tick();
    p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    p.w.dispatchEvent(new p.w.Event('online'));
    if (i === 5) { p.$('.tabs a[data-tab=events]').click(); btn.click(); assert.ok(p.shown('#p-signin'), 'Sign in again opens the sign-in card'); }
    await sleep(300);
  }
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.ok(oldSent() >= 1 && oldSent() <= 2, `the old code went out ${oldSent()} times, not on every retry`);
  assert.ok(wrong() <= 2, `${wrong()} wrong codes counted, far from the 20 that pause sign-in`);
  assert.equal(p.api.toasts.filter(s => /organizer code isn't right/.test(s)).length, 0, 'no "code isn\'t right" toast');
  assert.doesNotThrow(() => p.g.ctx.signIn(NEW), 'another organizer can still sign in with the new code');
  assert.notEqual(rowOf(p, 'w7')[titleCol(p)], 'Rain Plan Work Party');

  // signing in with the new code sends both changes, without reading the starter events again
  p.api.latency = 200;
  await startSignIn(p, NEW, 'Jessie');
  await waitFor(() => p.shown('#p-events') && chipText(p) === 'Saving…', 3000, 'the events page, saving');
  await waitFor(() => chipText(p) === 'All changes saved', 3000, 'All changes saved');
  assert.equal(rowOf(p, 'w7')[titleCol(p)], 'Rain Plan Work Party', 'the Sheet has the first change');
  assert.equal(rowOf(p, 'm2')[titleCol(p)], 'Winter Potluck', 'and the second');
  assert.ok(!p.$$('#tiles .unsaved').length, 'no tile says Not saved');
  assert.equal(p.api.sent.slice(from).filter(c => c.fn === 'seed').length, 0, 'no seed');
  assert.equal(p.w.sessionStorage.getItem('ebpg-code'), NEW, 'the new code is kept for this tab');
  assert.ok(p.api.toasts.includes('Signed in as Jessie'));
  assert.ok(!btn.textContent.includes('Sign in again'), 'the chip button is Retry again');
  assert.ok(![...p.api.toasts, p.$('#si-err').textContent].some(s => /^Too many tries/.test(s)), 'sign-in never paused');
  assert.ok(!unloadWarns(p), 'nothing left to warn about');

  // the next 2-minute read uses the new code
  const reads = p.api.sent.filter(c => c.fn === 'signIn').length;
  p.api.tick();
  await waitFor(() => p.api.sent.filter(c => c.fn === 'signIn').length > reads && p.idle(), 2000, 'the next read');
  assert.equal(p.api.sent.at(-1).args[0], NEW);
  p.noErrors();
});

test('the test-mode banner is not redrawn when nothing in it changed, so a focused link keeps focus', async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  const link = p.$('#testbar a');
  link.focus();
  const reads = p.api.calls.filter(c => c === 'signIn').length;
  p.d.dispatchEvent(new p.w.Event('visibilitychange'));
  await waitFor(() => p.api.calls.filter(c => c === 'signIn').length > reads && p.idle(), 3000, 'the Sheet to be read again');
  assert.ok(link.isConnected && p.d.activeElement === link, 'the same link still has focus');
  p.noErrors();
});

test('when the 2-minute read finds the code changed while an event is open, the pop-up stays open and its chip offers Sign in again', async t => {
  const p = await openPage(t, fastTimers);
  await signIn(p, 'Jessie');
  p.$('#tiles [data-open="w7"]').click();
  await waitFor(() => p.$('#detail #edit-ev'), 2000, 'the event to open');
  newCode(p, 'garden-new-1357');
  const from = p.api.sent.length;
  p.api.tick();
  await waitFor(() => p.api.toasts.includes('The organizer code was changed. Sign in again with the new code.'), 2000, 'the toast');
  assert.ok(p.shown('#modal') && !p.shown('#p-signin'), 'the pop-up stays open');
  await editTitle(p, 'w7', 'Rain Plan Work Party');
  const chip = p.$('#m-savest'), btn = chip.querySelector('button');
  await waitFor(() => chip.dataset.state === 'stale', 2000, 'the pop-up chip to say Not saved');
  await sleep(1000); // the save delay, then retries
  assert.equal(p.api.sent.length, from + 1, 'nothing sent after the read that was turned down');
  assert.ok(!btn.hidden && btn.textContent === 'Sign in again' && btn.querySelector('use[href="#i-log-in"]'));
  btn.click();
  assert.ok(!p.shown('#modal') && p.shown('#p-signin'), 'Sign in again closes the pop-up and opens the sign-in card');
  assert.equal(p.d.activeElement, p.$('#si-code'));
  assert.match(p.$('#si-err').textContent, /^The organizer code was changed/);
  // picking a name without typing the new code doesn't send the old one
  p.$('#si-pick button[data-as="Jessie"]').click();
  assert.equal(p.$('#si-err').textContent, 'Type the organizer code first.');
  await sleep(50);
  assert.equal(p.api.sent.length, from + 1);
  p.noErrors();
});

/* ---------- outreach review: approve, copy, mark as posted with a link, undo ---------- */
const pill = (p, ch) => p.$(`#dp-out [data-row="${ch}"] .pill`).textContent;
const acts = (p, ch) => p.$$(`#dp-out [data-row="${ch}"] .oacts > *`).map(b => b.textContent.trim());
const postRow = (p, ev, ch) => { const [head, ...rows] = p.g.tab('Posts'), r = rows.find(x => x[0] === ev && x[1] === ch); return r && Object.fromEntries(head.map((h, i) => [h, r[i]])); };
const activity = (p, ev) => p.g.tab('Activity').filter(r => r[0] === ev).map(r => r[2]);
async function outreach(p, id) {
  p.$(`#tiles [data-open="${id}"]`).click();
  (await waitFor(() => p.$('#detail [data-dtab="outreach"]'), 2000, 'the event to open')).click();
  return waitFor(() => p.shown('#dp-out') && p.$$('#dp-out .orow').length && p.$('#dp-out'), 2000, 'the Outreach tab');
}

test('outreach review: Phil approves Partiful, copies it, marks it posted with a link, and it stays posted after a reload until Undo', async t => {
  const p = await openPage(t);
  await signIn(p, 'Phil');
  const drafts = p.g.tab('Posts').slice(1).filter(r => r[2] === 'review').length;
  assert.ok(drafts >= 2);
  assert.equal(p.$('#attn .grow').textContent, `${drafts} drafts to review · 0 approved, ready to post`);
  assert.ok(!/posts ready to go out/.test(p.d.body.textContent));

  // Review next opens the soonest event with drafts, on its Outreach tab
  p.$('#jump').click();
  await waitFor(() => p.shown('#dp-out') && p.$$('#dp-out .orow').length, 2000, 'Review next to open the Outreach tab');
  assert.equal(p.$('#m-title').textContent, 'Workday #7', 'Workday #7 is next');
  const rows = p.$$('#dp-out .orow');
  assert.ok(rows.every(r => r.classList.contains('review') && r.querySelector('.pill').textContent === 'Draft · needs review'), 'every channel is a draft');
  assert.ok(rows.every(r => { const b = r.querySelector('[data-act=approve]'); return b && !b.disabled; }), 'every draft shows Approve');
  assert.ok(!p.$('#dp-out [data-act=post], #dp-out [data-act=copy], #dp-out [data-act=mark]'), 'nothing to post or copy before approval');
  assert.match(p.$('#dp-out .osum').textContent, new RegExp(`^${rows.length} drafts to review · 0 approved, ready to post · 0 posted`));
  assert.equal(p.$('#appr-all').textContent, 'Approve all drafts');

  // Approve: the text stays editable, and Copy text, Open Partiful and Mark as posted take its place
  p.$('#dp-out [data-act=approve][data-ch=partiful]').click();
  assert.equal(pill(p, 'partiful'), 'Approved by Phil');
  assert.deepEqual(acts(p, 'partiful'), ['Copy text', 'Open Partiful', 'Mark as posted']);
  assert.equal(p.$('#dp-out [data-row=partiful] .oacts a').href, 'https://partiful.com/');
  assert.equal(p.d.activeElement.dataset.act, 'copy', 'focus moves to Copy text');
  assert.match(p.$('#attn .grow').textContent, new RegExp(`^${drafts - 1} drafts to review · 1 approved, ready to post$`));
  p.$('#dp-out [data-row=partiful] [data-act=toggle]').click();
  assert.equal(p.$('#ta-w7-partiful').readOnly, false, 'approved text stays editable');

  // Copy text: on the clipboard, logged, and still only approved
  const text = p.$('#ta-w7-partiful').value;
  p.$('#dp-out [data-act=copy][data-ch=partiful]').click();
  await waitFor(() => p.api.copied.includes(text), 2000, 'the Partiful text on the clipboard');
  await waitFor(() => p.api.toasts.includes('Copied. Paste it on Partiful.'), 2000, 'the copied toast');
  assert.ok(p.$('#dp-out [data-row=partiful]').classList.contains('approved'), 'copying is not posting');
  p.$('#dp-out [data-act=copy][data-ch=partiful]').click();
  await waitFor(() => p.api.copied.filter(x => x === text).length === 2 && p.api.toasts.filter(x => x === 'Copied. Paste it on Partiful.').length === 2, 2000, 'a second copy');

  // Mark as posted: an optional https link
  p.$('#dp-out [data-act=mark][data-ch=partiful]').click();
  const input = p.$('#mk-w7-partiful');
  assert.equal(p.d.activeElement, input, 'the link field gets focus');
  assert.equal(input.closest('label').textContent, 'Link to the post (optional, https)');
  assert.deepEqual(acts(p, 'partiful'), ['Copy text', 'Open Partiful'], 'no second Mark as posted while the field is open');
  p.set('#mk-w7-partiful', 'partiful.com/e/abc');
  p.$('form[data-mark=partiful] button[type=submit]').click();
  assert.ok(p.shown('#mk-w7-partiful-err'), 'a link without https:// is refused');
  assert.equal(p.$('#mk-w7-partiful').getAttribute('aria-invalid'), 'true');
  assert.ok(p.$('#dp-out [data-row=partiful]').classList.contains('approved'));
  p.set('#mk-w7-partiful', 'https://partiful.com/e/abc');
  p.$('form[data-mark=partiful] button[type=submit]').click();
  assert.match(pill(p, 'partiful'), /^Posted by Phil · Oct 2[45]$/);
  const view = p.$('#dp-out [data-row=partiful] .ostat a');
  assert.equal(view.textContent, 'View post');
  assert.equal(view.href, 'https://partiful.com/e/abc');
  assert.equal(view.target, '_blank');
  assert.deepEqual(acts(p, 'partiful'), ['Undo']);
  assert.equal(p.d.activeElement.dataset.act, 'undo', 'focus moves to Undo');
  p.$('#dp-out [data-row=partiful] [data-act=toggle]').click();
  assert.equal(p.$('#ta-w7-partiful').readOnly, true, 'a posted text is read-only');
  checkIcons(p, 'outreach review');

  // the Posts tab: posted, by Phil, when, and the link
  await waitFor(() => postRow(p, 'w7', 'partiful')?.status === 'posted', 3000, 'the Posts row to say posted');
  const row = postRow(p, 'w7', 'partiful');
  assert.equal(row['posted by'], 'Phil');
  assert.equal(row['approved by'], 'Phil');
  assert.match(row['approved at'], /^2026-10-2\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.match(row['posted at'], /^2026-10-2\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(row['post url'], 'https://partiful.com/e/abc');
  await waitFor(p.idle, 2000, 'saves to finish');
  assert.deepEqual(activity(p, 'w7').slice(-3), ['Phil approved Partiful', 'Phil copied the Partiful text', 'Phil marked Partiful as posted'], 'two copies are one line');
  p.noErrors();

  // a reload of the page: still posted, with View post
  const q = await openPage(t, null, p.g);
  await signIn(q, 'Phil');
  assert.ok(!q.api.calls.includes('seed'));
  await outreach(q, 'w7');
  assert.ok(q.$('#dp-out [data-row=partiful]').classList.contains('posted'));
  assert.match(pill(q, 'partiful'), /^Posted by Phil · Oct 2[45]$/);
  assert.equal(q.$('#dp-out [data-row=partiful] .ostat a').href, 'https://partiful.com/e/abc');
  assert.match(q.$('#dp-out .osum > span').textContent, / · 1 posted$/);

  // Undo: back to approved, and the Sheet forgets the post
  q.$('#dp-out [data-act=undo][data-ch=partiful]').click();
  assert.equal(pill(q, 'partiful'), 'Approved by Phil');
  assert.deepEqual(acts(q, 'partiful'), ['Copy text', 'Open Partiful', 'Mark as posted']);
  assert.ok(!q.$('#dp-out [data-row=partiful] .ostat a'), 'no View post');
  await waitFor(() => postRow(q, 'w7', 'partiful')?.status === 'approved', 3000, 'the Posts row back to approved');
  assert.deepEqual(['posted by', 'posted at', 'post url'].map(k => postRow(q, 'w7', 'partiful')[k]), ['', '', '']);
  await waitFor(q.idle, 2000, 'saves to finish');
  assert.equal(activity(q, 'w7').at(-1), 'Phil un-marked Partiful');

  // changing approved text puts it back in review, with the caret where it was
  q.$('#dp-out [data-row=partiful] [data-act=toggle]').click();
  const ta = q.$('#ta-w7-partiful');
  ta.focus();
  q.set('#ta-w7-partiful', ta.value + ' See you there!');
  assert.equal(pill(q, 'partiful'), 'Draft · needs review');
  assert.equal(q.d.activeElement.id, 'ta-w7-partiful', 'typing carries on in the text');
  assert.deepEqual(acts(q, 'partiful'), ['Approve']);

  // Approve all drafts: one line each
  const left = q.$$('#dp-out .orow.review').map(r => r.dataset.row);
  q.$('#appr-all').click();
  assert.equal(q.$$('#dp-out .orow.review').length, 0);
  assert.ok(!q.$('#appr-all'), 'gone once nothing is left to review');
  await waitFor(() => q.api.toasts.includes(`Approved ${left.length} drafts`), 2000, 'the approved toast');
  await waitFor(() => q.g.tab('Posts').slice(1).filter(r => r[0] === 'w7').every(r => r[2] === 'approved'), 3000, 'every w7 Posts row approved');
  await waitFor(q.idle, 2000, 'saves to finish');
  const names = { partiful: 'Partiful', ggroup: 'Google Group email', calendar: 'Guild Google Calendar', instagram: 'Instagram', chats: 'WhatsApp & Hylo chats', luma: 'Luma', meetup: 'Meetup', facebook: 'Facebook group' };
  assert.deepEqual(activity(q, 'w7').slice(-left.length), left.map(c => 'Phil approved ' + names[c]));
  // the Google Group and the Calendar get Post once approved; copy channels never say posted on their own
  assert.deepEqual(acts(q, 'ggroup'), ['Post']);
  assert.ok(q.$$('#dp-out .orow').every(r => !/Posted/.test(r.querySelector('.pill').textContent)));
  q.noErrors();
});

test('without "Approve & post": Approve is turned off, the text is read-only, and the hint says who can approve', async t => {
  const p = await openPage(t);
  await signIn(p, 'Kalynn');
  await outreach(p, 'w7');
  const approve = p.$$('#dp-out [data-act=approve]');
  assert.ok(approve.length >= 2 && approve.every(b => b.disabled && b.getAttribute('aria-disabled') === 'true' && b.title === 'You need "Approve & post"'), 'Approve is turned off');
  assert.ok(p.$('#appr-all').disabled, 'and so is Approve all drafts');
  const hints = p.$$('#dp-out .orow .ostat .hint').map(h => h.textContent);
  assert.equal(hints.length, approve.length);
  assert.ok(hints.every(h => h === 'Jessie, Phil or Sky can approve this'), hints[0]);
  assert.ok(p.$$('#dp-out .orow .pill').every(x => x.textContent === 'Draft · needs review'));
  p.$('#dp-out [data-row=partiful] [data-act=toggle]').click();
  assert.equal(p.$('#ta-w7-partiful').readOnly, true, 'the text is read-only');
  approve[0].click();
  assert.equal(p.$$('#dp-out .orow.review').length, approve.length, 'a click on a turned-off Approve does nothing');
  p.$('#m-x').click();
  p.$('.tabs a[data-tab=team]').click();
  assert.ok(p.$$('#team-tbl thead th').some(th => th.textContent === 'Approve & post'), 'the Team table names the permission');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

/* ---------- Post: the Sheet saves the event, sends it once, and records it ---------- */
const TEST_SENT = 'Test sent (Test mode is on: this went only to the Sheet owner)';
const pacific = (d, t) => new Date(`${d}T${t}:00-07:00`).toISOString(); // late October is still daylight time in Oakland
const chips = p => p.$$('#dp-out .orow .warnchip').map(c => [c.closest('.orow').dataset.row, c.textContent]);

test("Post on a brand-new event: the Group email goes out at once with its title, the row says Test sent, and nothing is saved twice", async t => {
  const p = await openPage(t);
  await signIn(p, 'Phil');
  p.$('#new-ev').click();
  await waitFor(() => p.$('#editf'), 2000, 'the new-event form');
  p.set('#ed-title', 'Seed swap at the OPC');
  p.set('#ed-date', '2026-11-07');
  p.$('#editf button[type=submit]').click();
  // straight to Outreach, approve and post, before the event's own save has gone out
  (await waitFor(() => p.$('#detail [data-dtab="outreach"]'), 2000, 'the new event')).click();
  p.$('#dp-out [data-act=approve][data-ch=ggroup]').click();
  assert.equal(pill(p, 'ggroup'), 'Approved by Phil');
  p.api.latency = 150;
  const post = p.$('#dp-out [data-act=post][data-ch=ggroup]');
  post.click();
  assert.ok(post.disabled, 'Post is turned off while it goes');
  assert.equal(post.textContent, 'Posting…');
  assert.equal(post.getAttribute('aria-busy'), 'true');
  // a redraw while it's going still can't offer Post again
  p.$('#dp-out [data-row=partiful] [data-act=toggle]').click();
  const again = p.$('#dp-out [data-act=post][data-ch=ggroup]');
  assert.ok(again.disabled && again.textContent === 'Posting…', 'still Posting… after a redraw');
  await waitFor(() => p.$('#dp-out [data-row=ggroup] .pill').textContent === TEST_SENT, 3000, 'the Group row to say Test sent');
  p.api.latency = 0;
  const call = p.api.sent.find(c => c.fn === 'postTo');
  const id = call.args[1].id;
  assert.match(id, /^n\d+$/);
  assert.deepEqual([call.args[2], call.args[3]], ['ggroup', { by: 'Phil', force: false }]);
  assert.equal(call.args[1].cols.title, 'Seed swap at the OPC', 'the event as it is on the page');
  assert.equal(p.$('#dp-out [data-row=ggroup] .pill').title, 'Test mode is on: this went only to the Sheet owner');
  assert.deepEqual(acts(p, 'ggroup'), [], 'nothing more to do in test mode');
  await waitFor(() => p.api.toasts.includes('Test sent. Test mode is on, so the Google Group email went only to owner@example.com.'), 2000, 'the Test sent toast');
  // one email, with the title as it was when Post was pressed
  assert.equal(p.g.mail.length, 1);
  assert.equal(p.g.mail[0].subject, '[TEST to the Google Group] Sat 11/7: Seed swap at the OPC at Oakland Peace Center');
  assert.equal(p.g.tab('Events').filter(r => r[0] === id).length, 1, 'the event is on the Events tab');
  const row = postRow(p, id, 'ggroup');
  assert.deepEqual([row.status, row['posted by'], row['approved by']], ['test', 'Phil', 'Phil']);
  assert.equal(activity(p, id).at(-1), 'Phil posted to the Google Group (test mode: only the Sheet owner got it)');
  assert.equal(p.$('#log-body li:first-child span:last-child').textContent, 'Phil posted to the Google Group (test mode: only the Sheet owner got it)');
  assert.match(p.$('#dp-out .osum > span').textContent, / · 0 posted · 1 test sent$/);
  // the Sheet has it all already, so no save follows
  await sleep(1100);
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.deepEqual(p.api.sent.filter(c => c.fn === 'saveEvent' && c.args[1].id === id), [], 'no saveEvent for the new event');
  assert.ok(['idle', 'saved'].includes(p.$('#m-savest').dataset.state), 'nothing waiting to be saved');
  checkIcons(p, 'a test-sent post');
  p.noErrors();
});

test('after posting, a new start time says Changed since posted; Update calendar moves the one entry, and Draft an update goes back for approval', async t => {
  const p = await openPage(t);
  await signIn(p, 'Phil');
  await outreach(p, 'w7');
  for (const ch of ['calendar', 'ggroup']) {
    p.$(`#dp-out [data-act=approve][data-ch=${ch}]`).click();
    p.$(`#dp-out [data-act=post][data-ch=${ch}]`).click();
    await waitFor(() => pill(p, ch) === TEST_SENT, 3000, ch + ' to be sent');
  }
  const [date, start] = (r => [r[3], r[4]])(p.g.tab('Events').find(r => r[0] === 'w7'));
  assert.equal(p.g.calendar.length, 1);
  const entry = { ...p.g.calendar[0] };
  assert.deepEqual([entry.cal, entry.title, entry.start.toISOString()], ['default', '[TEST] ' + p.$('#detail .dh h2').textContent, pacific(date, start)]);
  assert.equal(postRow(p, 'w7', 'calendar')['calendar id'], entry.id);
  assert.deepEqual(chips(p), [], 'nothing changed yet');

  // the start time changes in Edit event
  p.$('#edit-ev').click();
  p.set('#ed-start', '11:00');
  p.$('#editf button[type=submit]').click();
  (await waitFor(() => p.$('#detail [data-dtab="outreach"]'), 2000, 'the event')).click();
  assert.deepEqual(chips(p), [['ggroup', 'Changed since posted'], ['calendar', 'Changed since posted']]);
  assert.deepEqual(acts(p, 'calendar'), ['Update calendar']);
  assert.deepEqual(acts(p, 'ggroup'), ['Draft an update']);
  await waitFor(() => postRow(p, 'w7', 'calendar').stale === 'yes' && postRow(p, 'w7', 'ggroup').stale === 'yes', 3000, 'the Posts rows to say stale');
  assert.equal(postRow(p, 'w7', 'calendar').status, 'test', 'still sent');
  // the change is kept over a reload
  const q = await openPage(t, null, p.g);
  await signIn(q, 'Phil');
  await outreach(q, 'w7');
  assert.deepEqual(chips(q), [['ggroup', 'Changed since posted'], ['calendar', 'Changed since posted']]);

  // Update calendar
  const up = p.$('#dp-out [data-act=update][data-ch=calendar]');
  up.click();
  assert.ok(up.disabled && up.textContent === 'Updating…');
  await waitFor(() => !p.$('#dp-out [data-row=calendar] .warnchip'), 3000, 'the calendar chip to go');
  assert.equal(p.g.calendar.length, 1, 'still one entry');
  assert.equal(p.g.calendar[0].id, entry.id);
  assert.equal(p.g.calendar[0].start.toISOString(), pacific(date, '11:00'));
  assert.equal(pill(p, 'calendar'), TEST_SENT);
  assert.equal(postRow(p, 'w7', 'calendar').stale, '');
  assert.ok(p.api.toasts.includes("Test sent. Test mode is on, so it was updated on the Sheet owner's calendar, marked [TEST]."));
  assert.equal(activity(p, 'w7').at(-1), "Phil updated the Calendar (test mode: on the Sheet owner's calendar)");
  const upCall = p.api.sent.filter(c => c.fn === 'postTo').at(-1);
  assert.deepEqual(upCall.args[3], { by: 'Phil', force: true });

  // Draft an update: a new Group email, back in review
  p.$('#dp-out [data-act=redraft][data-ch=ggroup]').click();
  assert.equal(pill(p, 'ggroup'), 'Draft · needs review');
  assert.deepEqual(acts(p, 'ggroup'), ['Approve']);
  assert.ok(!p.$('#dp-out [data-row=ggroup] .warnchip'));
  const text = p.$('#ta-w7-ggroup').value;
  assert.match(text, /^Subject: Update: .+, Sun 10\/25\n\nHi all,\n\n/);
  assert.equal((text.match(/^Subject:/gm) || []).length, 1, 'one subject line');
  assert.match(text, /When: .*11:00 AM/);
  await waitFor(() => postRow(p, 'w7', 'ggroup').status === 'review', 3000, 'the Group row back to review in the Sheet');
  assert.equal(postRow(p, 'w7', 'ggroup')['posted by'], '');
  p.$('#dp-out [data-act=approve][data-ch=ggroup]').click();
  p.$('#dp-out [data-act=post][data-ch=ggroup]').click();
  await waitFor(() => pill(p, 'ggroup') === TEST_SENT, 3000, 'the update to be sent');
  assert.equal(p.g.mail.length, 2);
  assert.match(p.g.mail[1].subject, /^\[TEST to the Google Group\] Update: .+, Sun 10\/25$/);
  assert.match(p.g.mail[1].body, /11:00 AM/);
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.deepEqual(activity(p, 'w7').slice(-3), ['Phil drafted an update for Google Group email', 'Phil approved Google Group email', 'Phil posted to the Google Group (test mode: only the Sheet owner got it)']);
  checkIcons(p, 'changed since posted');
  p.noErrors();
});

test("a Post the Sheet doesn't answer leaves it approved; a tab that missed the post can't send it again or undo it", async t => {
  const p = await openPage(t);
  await signIn(p, 'Phil');
  const q = await openPage(t, null, p.g); // a second tab, open before the post
  await signIn(q, 'Jessie');
  await outreach(p, 'w7');
  await outreach(q, 'w7');
  p.$('#dp-out [data-act=approve][data-ch=ggroup]').click();
  q.$('#dp-out [data-act=approve][data-ch=ggroup]').click();
  await waitFor(() => p.idle() && q.idle() && postRow(p, 'w7', 'ggroup').status === 'approved', 3000, 'both saves');

  p.api.fail = 'postTo';
  p.$('#dp-out [data-act=post][data-ch=ggroup]').click();
  await waitFor(() => p.api.toasts.includes("The Guild Sheet didn't answer, so we can't tell if it went out. Check the Sheet before posting again."), 3000, 'the no-answer toast');
  const btn = p.$('#dp-out [data-act=post][data-ch=ggroup]');
  assert.ok(btn && !btn.disabled && btn.textContent === 'Post', 'Post is back as it was');
  assert.match(pill(p, 'ggroup'), /^Approved by /);
  assert.equal(p.g.mail.length, 0);
  p.api.fail = '';
  p.$('#dp-out [data-act=post][data-ch=ggroup]').click();
  await waitFor(() => pill(p, 'ggroup') === TEST_SENT, 3000, 'the post');
  assert.equal(p.g.mail.length, 1);

  // the other tab still shows Post: the Sheet says it went already
  q.$('#dp-out [data-act=post][data-ch=ggroup]').click();
  await waitFor(() => q.api.toasts.includes('Already posted. To tell the Group about a change, use Draft an update.'), 3000, 'the Already posted toast');
  assert.equal(p.g.mail.length, 1, 'no second email');
  assert.deepEqual(acts(q, 'ggroup'), ['Post'], 'left as it was');
  // and that tab's next save doesn't make it a draft again in the Sheet
  q.$('#detail [data-dtab="plan"]').click();
  q.set('#nt-text', 'Bring a sun hat');
  q.$('#nt-add').click();
  await waitFor(() => p.g.tab('Bringing').some(r => r[0] === 'w7' && r[1] === 'Bring a sun hat') && q.idle(), 3000, "the other tab's save");
  assert.deepEqual([postRow(p, 'w7', 'ggroup').status, postRow(p, 'w7', 'ggroup')['posted by']], ['test', 'Phil']);
  assert.deepEqual(p.api.errors, []);
  q.noErrors();
});

test('the prototype artifact: Changed since posted and Update calendar work without a server', async t => {
  const p = loadPage(t, ARTIFACT, 'http://localhost/artifact');
  await waitFor(() => p.shown('#p-landing'), 2000, 'the artifact landing page');
  p.$('#signin-top').click();
  p.$('#si-google').click();
  p.$('#tiles [data-open="w7"]').click();
  p.$('#detail [data-dtab="outreach"]').click();
  p.$('#dp-out [data-act=approve][data-ch=calendar]').click();
  p.$('#dp-out [data-act=post][data-ch=calendar]').click();
  await waitFor(() => /^Posted by Jessie/.test(pill(p, 'calendar')), 2000, 'the simulated post');
  p.$('#edit-ev').click();
  p.set('#ed-start', '11:00');
  p.$('#editf button[type=submit]').click();
  p.$('#detail [data-dtab="outreach"]').click();
  assert.deepEqual(chips(p), [['calendar', 'Changed since posted']]);
  p.$('#dp-out [data-act=update][data-ch=calendar]').click();
  await waitFor(() => p.api.toasts.includes('Updated Guild Google Calendar (simulated)'), 2000, 'the simulated update');
  assert.deepEqual(chips(p), []);
  assert.deepEqual(p.api.calls, [], 'the artifact calls no server');
  p.noErrors();
});

test('a test send, once test mode is off: Post for real sends it to the Group and says Posted', async t => {
  const p = await openPage(t);
  await signIn(p, 'Phil');
  await outreach(p, 'w7');
  p.$('#dp-out [data-act=approve][data-ch=ggroup]').click();
  p.$('#dp-out [data-act=post][data-ch=ggroup]').click();
  await waitFor(() => pill(p, 'ggroup') === TEST_SENT, 3000, 'the test send');
  assert.deepEqual(acts(p, 'ggroup'), [], 'no Post for real while test mode is on');
  await waitFor(p.idle, 2000, 'calls to finish');
  // the owner turns test mode off and adds the Group's address; Phil signs in again
  const set = (k, v) => p.g.sheets.get('Settings').set(p.g.tab('Settings').findIndex(r => r[0] === k) + 1, 2, v);
  set('TEST_MODE', 'FALSE'); set('GROUP_EMAIL', 'ebpg@googlegroups.com');
  p.$('#signout').click();
  await signIn(p, 'Phil');
  assert.ok(!p.shown('#testbar'), 'no test-mode banner');
  await outreach(p, 'w7');
  assert.equal(pill(p, 'ggroup'), TEST_SENT);
  assert.deepEqual(acts(p, 'ggroup'), ['Post for real']);
  // a second tab, open since before the real post, offers Post for real too
  const q = await openPage(t, null, p.g);
  await signIn(q, 'Jessie');
  await outreach(q, 'w7');
  assert.deepEqual(acts(q, 'ggroup'), ['Post for real']);
  p.$('#dp-out [data-act=again][data-ch=ggroup]').click();
  await waitFor(() => /^Posted by Phil · Oct 2[45]$/.test(pill(p, 'ggroup')), 3000, 'the real post');
  assert.deepEqual(p.g.mail.map(m => m.to), ['owner@example.com', 'ebpg@googlegroups.com']);
  assert.equal(postRow(p, 'w7', 'ggroup').status, 'posted');
  assert.deepEqual(acts(p, 'ggroup'), []);
  await waitFor(() => p.api.toasts.includes('Emailed the Google Group.'), 2000, 'the toast');
  await waitFor(p.idle, 2000, 'calls to finish');
  // the other tab presses it: the Sheet says it went already, and the Group gets no second email
  q.$('#dp-out [data-act=again][data-ch=ggroup]').click();
  await waitFor(() => q.api.toasts.includes('Already posted. To tell the Group about a change, use Draft an update.'), 3000, 'the Already posted toast');
  assert.deepEqual(p.g.mail.map(m => m.to), ['owner@example.com', 'ebpg@googlegroups.com'], 'one email to the Group');
  assert.deepEqual([postRow(p, 'w7', 'ggroup').status, postRow(p, 'w7', 'ggroup')['posted by']], ['posted', 'Phil']);
  await waitFor(q.idle, 2000, 'calls to finish');
  p.noErrors();
  q.noErrors();
});

test("the Outreach summary says Everything is posted only when it all went out for real, not just as tests", async t => {
  const p = await openPage(t);
  await signIn(p, 'Phil');
  await outreach(p, 'w7');
  const used = p.$$('#dp-out .orow').map(r => r.dataset.row);
  assert.ok(used.includes('ggroup') && used.includes('calendar'));
  const copy = used.filter(ch => ch !== 'ggroup' && ch !== 'calendar');
  p.$('#appr-all').click();
  for (const ch of ['ggroup', 'calendar']) {
    p.$(`#dp-out [data-act=post][data-ch=${ch}]`).click();
    await waitFor(() => pill(p, ch) === TEST_SENT, 3000, ch + ' to be sent');
  }
  for (const ch of copy) {
    p.$(`#dp-out [data-act=mark][data-ch=${ch}]`).click();
    p.$(`form[data-mark=${ch}] button[type=submit]`).click();
  }
  const say = () => p.$('#dp-out .osum > span').textContent;
  assert.equal(say(), `Everything has gone out · ${copy.length} posted · 2 test sent (the tests went only to the Sheet owner)`);
  assert.ok(p.$('#dp-out .osum > span svg use[href="#i-check"]'), 'with its icon');
  await waitFor(p.idle, 2000, 'calls to finish');
  // once test mode is off and both go out for real, it's all posted
  const set = (k, v) => p.g.sheets.get('Settings').set(p.g.tab('Settings').findIndex(r => r[0] === k) + 1, 2, v);
  set('TEST_MODE', 'FALSE'); set('GROUP_EMAIL', 'ebpg@googlegroups.com');
  p.$('#signout').click();
  await signIn(p, 'Phil');
  await outreach(p, 'w7');
  p.$('#dp-out [data-act=again][data-ch=ggroup]').click();
  await waitFor(() => /^Posted by Phil/.test(pill(p, 'ggroup')), 3000, 'the real Group post');
  assert.equal(say(), `Everything has gone out · ${copy.length + 1} posted · 1 test sent (the test went only to the Sheet owner)`);
  p.$('#dp-out [data-act=again][data-ch=calendar]').click();
  await waitFor(() => /^Posted by Phil/.test(pill(p, 'calendar')), 3000, 'the real Calendar post');
  assert.equal(say(), `Everything is posted · ${copy.length + 2} posted`);
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

/* ---------- draft and published events, and the RSVP link ---------- */
const evCell = (p, id, head) => { const t = p.g.tab('Events'); return (t.find(r => r[0] === id) || [])[t[0].indexOf(head)]; };
const pubIds = p => JSON.parse(JSON.stringify(p.g.ctx.getPublic().events.map(e => e.id)));

test('the starter events: past ones and Workday #7 are published, Community Meeting #2 is a draft with a Draft badge', async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  assert.deepEqual(Object.fromEntries(p.g.tab('Events').slice(1).map(r => [r[0], evCell(p, r[0], 'status')])),
    { w2: 'published', w5: 'published', m1: 'published', w6: 'published', w7: 'published', m2: 'draft' });
  assert.deepEqual(pubIds(p), ['w7'], 'the public page gets Workday #7, not the draft');
  const m2 = p.$('#tiles [data-open="m2"]'), w7 = p.$('#tiles [data-open="w7"]');
  assert.equal(m2.querySelector('.tstat').textContent, 'Draft');
  assert.ok(m2.querySelector('.tstat use[href="#i-lock"]'), 'with a lock icon');
  assert.match(m2.getAttribute('aria-label'), /\. Draft, only organizers see it$/);
  assert.ok(!w7.querySelector('.tstat') && !/Draft/.test(w7.getAttribute('aria-label')), 'no badge on a published event');
  m2.click();
  await waitFor(() => p.$('#detail #dp-plan'), 2000, 'Community Meeting #2 to open');
  assert.equal(p.$('#detail .dh .pill.ev-draft').textContent, 'Draft, only organizers see it');
  const pub = p.$('#detail #publish-ev');
  assert.ok(pub && !pub.disabled && pub.querySelector('use[href="#i-eye"]'), 'a Publish button with an icon');
  assert.equal(pub.textContent, 'Publish');
  checkIcons(p, 'a draft event');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('Publish puts a draft on the public page, says so once the Sheet has it, and logs who did it', async t => {
  const p = await openPage(t);
  await signIn(p, 'Phil');
  p.$('#tiles [data-open="m2"]').click();
  const btn = await waitFor(() => p.$('#detail #publish-ev'), 2000, 'the Publish button');
  btn.click();
  assert.ok(!p.$('#detail #publish-ev') && !p.$('#detail .dh .pill.ev-draft'), 'the pill and the button go');
  assert.equal(p.d.activeElement, p.$('#detail #edit-ev'), 'focus moves to Edit event');
  assert.ok(!p.$('#tiles [data-open="m2"] .tstat'), 'the tile badge goes');
  assert.ok(!p.api.toasts.some(s => /^Published/.test(s)), 'not said before the Sheet has it');
  await waitFor(() => evCell(p, 'm2', 'status') === 'published', 3000, 'the status column to say published');
  await waitFor(() => p.api.toasts.includes("Published. It's on the public site now."), 2000, 'the toast');
  assert.ok(p.g.tab('Activity').some(r => r[0] === 'm2' && r[2] === 'Phil published the event'));
  assert.deepEqual(pubIds(p), ['w7', 'm2'], 'the public page has it right away');
  // signed out, the landing page uses only published events
  p.$('#m-x').click();
  p.$('#signout').click();
  const q = await openPage(t, null, p.g);
  assert.ok(q.shown('#p-landing'));
  assert.ok(q.$$('#hero-cards .art').length === 3, 'the next event is in the hero');
  assert.deepEqual(q.$$('#nextup a.nxcard').map(a => a.dataset.ev), ['w7', 'm2'], 'Community Meeting #2 is on the landing page now, after Workday #7');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors(); q.noErrors();
});

test("someone without Edit events sees the Draft pill but can't publish", async t => {
  const p = await openPage(t);
  await signIn(p, 'Sky'); // Sky can approve posts, not edit events
  p.$('#tiles [data-open="m2"]').click();
  const btn = await waitFor(() => p.$('#detail #publish-ev'), 2000, 'the Publish button');
  assert.ok(btn.disabled && btn.getAttribute('aria-disabled') === 'true');
  assert.equal(btn.title, 'You need "Edit events"');
  btn.click();
  await sleep(900);
  assert.equal(evCell(p, 'm2', 'status'), 'draft');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('the edit form: Status choice, and an RSVP link that must start with https://', async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  p.$('#tiles [data-open="w7"]').click();
  (await waitFor(() => p.$('#detail #edit-ev'), 2000, 'the event')).click();
  await waitFor(() => p.$('#editf'), 2000, 'the edit form');
  const radios = p.$$('#editf input[name=ed-status]');
  assert.deepEqual(radios.map(r => [r.value, r.checked, r.closest('label').textContent]), [['draft', false, 'Draft: only organizers see it'], ['published', true, 'Published: on the public site']]);
  assert.equal(p.$('#editf fieldset legend').textContent, 'Status');
  const rsvp = p.$('#ed-rsvp');
  assert.equal(rsvp.closest('label').textContent, 'RSVP link (optional, e.g. the Partiful event)');
  checkIcons(p, 'edit form with status');
  // an http link is refused, and nothing is saved
  p.set('#ed-rsvp', 'http://partiful.com/e/seedswap');
  p.$('#editf button[type=submit]').click();
  assert.equal(p.$('#ed-err').textContent, 'Paste a link that starts with https://');
  assert.ok(p.shown('#ed-err') && p.$('#editf'), 'the form stays open');
  assert.equal(p.d.activeElement, rsvp);
  assert.equal(rsvp.getAttribute('aria-invalid'), 'true');
  // a good link, and back to a draft
  p.set('#ed-rsvp', 'https://partiful.com/e/seedswap');
  radios[0].click();
  p.$('#editf button[type=submit]').click();
  await waitFor(() => !p.$('#editf'), 2000, 'the form to close');
  assert.ok(p.$('#detail .dh .pill.ev-draft') && p.$('#detail #publish-ev'), 'the header says Draft and offers Publish');
  await waitFor(() => evCell(p, 'w7', 'status') === 'draft' && evCell(p, 'w7', 'rsvp link') === 'https://partiful.com/e/seedswap', 3000, 'the Sheet');
  await waitFor(() => p.api.toasts.includes('Saved as a draft. Only organizers can see it.'), 2000, 'the toast');
  assert.deepEqual(p.g.tab('Activity').filter(r => r[0] === 'w7').slice(-2).map(r => r[2]), ['Jessie edited the event', 'Jessie made the event a draft']);
  assert.deepEqual(pubIds(p), [], 'off the public page');
  // published again from the form, with the link on the public page
  (await waitFor(() => p.$('#detail #edit-ev'), 2000, 'the event')).click();
  await waitFor(() => p.$('#editf'), 2000, 'the edit form');
  assert.equal(p.$('#ed-rsvp').value, 'https://partiful.com/e/seedswap', 'the link is kept');
  p.$$('#editf input[name=ed-status]')[1].click();
  p.$('#editf button[type=submit]').click();
  await waitFor(() => evCell(p, 'w7', 'status') === 'published', 3000, 'published again');
  await waitFor(() => p.api.toasts.includes("Saved and published. It's on the public site now."), 2000, 'the toast');
  assert.equal(p.g.ctx.getPublic().events[0].rsvp, 'https://partiful.com/e/seedswap');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('a new event starts as a draft, and a Sheet with nothing published shows no events on the landing page', async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  p.$('#new-ev').click();
  await waitFor(() => p.$('#editf #ed-title'), 2000, 'the new event form');
  assert.deepEqual(p.$$('#editf input[name=ed-status]').map(r => r.checked), [true, false], 'Draft is picked');
  p.set('#ed-title', 'Seed Swap');
  p.$('#editf button[type=submit]').click();
  await waitFor(() => p.api.toasts.includes('Event created as a draft. Only organizers can see it.'), 3000, 'the toast');
  const id = p.g.tab('Events').find(r => r[2] === 'Seed Swap')[0];
  assert.equal(evCell(p, id, 'status'), 'draft');
  assert.ok(p.$(`#tiles [data-open="${id}"] .tstat`), 'its tile says Draft');
  // Workday #7 made a draft by hand in the Sheet: a fresh visitor sees no events, and nothing breaks
  p.g.sheets.get('Events').set(p.g.tab('Events').findIndex(r => r[0] === 'w7') + 1, p.g.tab('Events')[0].indexOf('status') + 1, 'draft');
  p.g.ctx.saveTeam(p.code(), JSON.parse(JSON.stringify(p.g.ctx.signIn(p.code()).team))); // drops the cached public copy
  const q = await openPage(t, null, p.g);
  assert.deepEqual([q.$$('#hero-cards .art').length, q.$$('#nextup a.nxcard').length], [0, 0], 'no draft on the landing page');
  assert.equal(q.$('#nextup').textContent, "Next dates coming soon. Join the list and we'll tell you.");
  assert.ok(q.$$(NAMES).length >= 1, 'organizers can still sign in');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors(); q.noErrors();
});

/* ---------- the landing page, built only from the Sheet's published events ---------- */
const URL_SITE = 'http://localhost:8766/site';
const CACHE = 'ebpg-public-v1';
// what the page itself drew, without its scripts: none of the page's own starter plans may show before the Sheet answers
const drawn = p => p.d.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, '');
const STARTER = ['OPC Garden Work Party', 'Community Meeting', 'Workday #', 'Jessie', 'Kalynn'];
const LOADING = "Loading events…";
const SOON = "Next dates coming soon. Join the list and we'll tell you.";
const FAIL = "We couldn't load the latest dates. See our Linktree for upcoming events.";

test('the landing: Workday #7 from the Sheet, not the draft Community Meeting #2, as a link with Tomorrow; the intro and the names are the Sheet\'s', async t => {
  const sheet = await seededSheet(t);
  // the Settings tab's line about when the Guild meets, and a name changed on the Team tab, both typed by hand
  sheet.sheets.get('Settings').set(sheet.tab('Settings').findIndex(r => r[0] === 'SCHEDULE_TEXT') + 1, 2, 'Work days on 4th Sundays & potlucks <b>monthly</b>.');
  sheet.sheets.get('Team').set(sheet.tab('Team').findIndex(r => r[0] === 'Sky') + 1, 1, 'Skylar');
  delete sheet.cache['public:v1'];
  const p = await openPage(t, null, sheet);
  const cards = p.$$('#nextup > *');
  assert.deepEqual(cards.map(c => [c.tagName, c.getAttribute('href'), c.dataset.ev]), [['A', '?ev=w7', 'w7']], 'Workday #7 only: no draft, no past event, nothing made up');
  const card = cards[0];
  assert.equal(card.querySelector('.soon').textContent, 'Tomorrow');
  assert.ok(card.querySelector('.soon use[href="#i-clock"]'), 'with a clock icon');
  assert.ok(card.querySelector('.nxcover[aria-hidden="true"] .art.ig'), 'the Instagram art is its cover, and screen readers skip it');
  assert.deepEqual([...card.querySelector('.nb').children].map(x => x.textContent), ['Work party', 'OPC Garden Work Party', 'Sunday, October 25 · 10:00 AM', 'Oakland Peace Center']);
  assert.ok(!p.$('[data-signin]'), 'no event card sends people to the sign-in page');
  for (const s of ['Grace Room', 'Guild Monthly Meeting', '2nd Monday']) assert.ok(!drawn(p).includes(s), s);
  // the hero and the phones' Next up strip use the same event
  assert.equal(p.$$('#hero-cards .art').length, 3);
  assert.ok(p.shown('#hero-cards') && !p.shown('#hero-note'));
  const strip = p.$('#nextstrip');
  assert.equal(strip.className, 'nextstrip');
  assert.equal(strip.querySelector('.nsday').textContent, 'Oct25');
  assert.equal(strip.querySelector('.nsk').textContent, 'Next up · Tomorrow');
  assert.equal(strip.querySelector('.nsb b').textContent, 'OPC Garden Work Party');
  assert.equal(strip.querySelector('.nsb > span:last-child').textContent, '10am · Oakland Peace Center');
  const det = strip.querySelector('a.nsgo');
  assert.equal(det.getAttribute('href'), '?ev=w7');
  assert.equal(det.textContent, 'Details: OPC Garden Work Party', 'Details says which event to a screen reader');
  // the intro is the Settings tab's line, as plain text
  assert.equal(p.$('#sched').textContent, 'Work days on 4th Sundays & potlucks <b>monthly</b>.');
  // the names to sign in as are the Sheet's organizers, not the page's own list
  assert.deepEqual(p.$$(NAMES).map(b => b.dataset.as), ['Jessie', 'Phil', 'Kalynn', 'Skylar']);
  for (const id of ['#nextup', '#hero-cards', '#nextstrip', '#si-pick']) assert.ok(!p.$(id).hasAttribute('aria-busy'), id + ' is not busy');
  assert.ok(!p.$('.skel, .sk'), 'no grey shapes left');
  checkIcons(p, 'landing from the Sheet');
  p.noErrors();
});

/* a published event as the Sheet keeps it, for a Sheet filled by hand */
const sheetEv = (id, date, start, end, status, series = 'workday', title = 'Garden work day ' + id) => ({
  id, data: { id, series, num: 1, label: '', photo: 'trellis', tags: ['beginner'], plan: { roles: [['Host', ['Jessie']]], notes: [], timeline: [] } },
  cols: { label: '', title, date, start, end, place: 'Oakland Peace Center', address: '', host: 'Jessie', cohosts: '', about: 'Garden work.', bring: '', tags: 'beginner', notes: '', timeline: '', status },
  tasks: [], posts: [], log: [],
});
const LEAD = { name: 'Jessie', role: 'lead', contact: '', via: '', perms: { create: true, edit: true, approve: true, tasks: true, team: true } };

test('up to four upcoming events of any kind, soonest first, with Today and This Tuesday; never a draft, a cancelled, a past or an ended one', async t => {
  // Saturday Oct 24 2026 on the page's clock
  const events = [
    sheetEv('late', '2026-11-20', '10:00', '14:00', 'published'),
    sheetEv('sat', '2026-10-31', '10:00', '14:00', 'published'),
    sheetEv('tue', '2026-10-27', '18:00', '20:00', 'published', 'meeting', 'Seed library night'),
    sheetEv('fri', '2026-10-30', '10:00', '12:00', 'published', '', 'Seed swap'),
    sheetEv('tonight', '2026-10-24', '23:58', '23:59', 'published', 'meeting', 'Potluck under the oak'),
    sheetEv('over', '2026-10-24', '00:00', '00:01', 'published'),
    sheetEv('draft', '2026-10-25', '10:00', '14:00', 'draft'),
    sheetEv('gone', '2026-10-26', '10:00', '14:00', 'cancelled'),
    sheetEv('past', '2026-10-01', '10:00', '14:00', 'published'),
  ];
  const p = await openPage(t, (w, g) => { g.ctx.doGet({}); g.ctx.seed('garden-test-2468', { events, team: [LEAD], vols: [], gardens: [] }); });
  const cards = p.$$('#nextup a.nxcard');
  assert.deepEqual(cards.map(a => a.dataset.ev), ['tonight', 'tue', 'fri', 'sat'], 'four, soonest first');
  assert.deepEqual(cards.map(a => a.querySelector('.soon')?.textContent || ''), ['Today', 'This Tuesday', 'This Friday', ''], 'a week away has no chip');
  assert.deepEqual(cards.map(a => a.querySelector('.nk').textContent), ['Community meeting', 'Community meeting', 'Skill share', 'Work party']);
  assert.equal(p.$('#nextstrip .nsk').textContent, 'Next up · Today');
  assert.equal(p.$('#nextstrip .nsb > span:last-child').textContent, '11:58pm · Oakland Peace Center');
  assert.match(p.$('#hero-cards .art.ig').textContent, /Potluck under the oak/, 'the hero is the next one');
  p.noErrors();
});

test("until the Sheet answers: grey cards that say Loading events…, the names wait, and the page's own starter plans never show", async t => {
  const p = loadPage(t, SITE, URL_SITE, (w, g, api) => { api.latency = 400; }, await seededSheet(t));
  assert.ok(p.shown('#p-landing'));
  assert.equal(p.$('#nextup').getAttribute('aria-busy'), 'true');
  assert.equal(p.$$('#nextup .nxcard.skel').length, 3, 'three grey cards');
  assert.equal(p.$('#nextup').textContent, LOADING, 'saying Loading events… once');
  assert.deepEqual(p.$$('#nextup .nxcard.skel').map(c => c.getAttribute('aria-hidden')), [null, 'true', 'true'], 'the other two are skipped by screen readers');
  assert.equal(p.$('#hero-cards').getAttribute('aria-busy'), 'true');
  assert.equal(p.$$('#hero-cards .sk').length, 3);
  assert.ok(!p.$('#hero-cards .art') && !p.shown('#hero-note'));
  assert.equal(p.$('#nextstrip').getAttribute('aria-busy'), 'true');
  assert.match(p.$('#nextstrip').textContent, /Loading events…/);
  assert.equal(p.$('#si-pick').getAttribute('aria-busy'), 'true');
  assert.equal(p.$$('#si-pick button').length, 0, 'no names to pick yet');
  assert.equal(p.$('#si-pick').textContent, 'Loading names…');
  for (const s of STARTER) assert.ok(!drawn(p).includes(s), s + ' is not on the page');
  assert.equal(p.$('#sched').textContent, 'Garden work days at the Oakland Peace Center, plus community meetings with a potluck. Everyone is welcome, no experience needed.');
  await waitFor(() => p.$('#nextup a.nxcard'), 3000, "the Sheet's events");
  assert.ok(!p.$('#nextup').hasAttribute('aria-busy') && !p.$('#si-pick').hasAttribute('aria-busy') && !p.$('.sk'));
  assert.deepEqual(p.$$(NAMES).map(b => b.dataset.as), ['Jessie', 'Phil', 'Kalynn', 'Sky']);
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test("the Sheet's last public answer is kept on this device, shown at once on the next visit, then brought up to date", async t => {
  const sheet = await seededSheet(t);
  const p = await openPage(t, null, sheet);
  const kept = JSON.parse(p.w.localStorage.getItem(CACHE));
  assert.deepEqual(kept.st, JSON.parse(JSON.stringify(sheet.ctx.getPublic())), "getPublic's answer, as it came");
  assert.ok(Math.abs(kept.at - p.w.Date.now()) < 60000, 'with when it came');
  const raw = JSON.stringify(kept);
  for (const bad of ['ORGANIZER_CODE', p.code(), 'perms', 'leadNote', 'hard out', 'TEST_MODE']) assert.ok(!raw.includes(bad), bad + ' is not kept');
  // Community Meeting #2 is published meanwhile
  sheet.sheets.get('Events').set(sheet.tab('Events').findIndex(r => r[0] === 'm2') + 1, sheet.tab('Events')[0].indexOf('status') + 1, 'published');
  delete sheet.cache['public:v1'];
  const q = loadPage(t, SITE, URL_SITE, (w, g, api) => { w.localStorage.setItem(CACHE, JSON.stringify(kept)); api.latency = 300; }, sheet);
  assert.deepEqual(q.$$('#nextup a.nxcard').map(a => a.dataset.ev), ['w7'], "last visit's events, before the Sheet answers");
  assert.ok(!q.$('#nextup').hasAttribute('aria-busy') && !q.$('.sk'), 'no grey shapes');
  assert.deepEqual(q.$$(NAMES).map(b => b.dataset.as), ['Jessie', 'Phil', 'Kalynn', 'Sky'], 'names to pick at once');
  await waitFor(() => q.$$('#nextup a.nxcard').length === 2, 3000, "the Sheet's newer events");
  assert.deepEqual(q.$$('#nextup a.nxcard').map(a => a.dataset.ev), ['w7', 'm2']);
  assert.deepEqual(JSON.parse(q.w.localStorage.getItem(CACHE)).st.events.map(e => e.id), ['w7', 'm2'], 'and keeps the newer answer');
  // a device that won't keep anything (private window, blocked storage) still gets the page
  const r = await openPage(t, w => { Object.defineProperty(w, 'localStorage', { configurable: true, get() { throw new w.DOMException('blocked', 'SecurityError'); } }); }, sheet);
  assert.deepEqual(r.$$('#nextup a.nxcard').map(a => a.dataset.ev), ['w7', 'm2']);
  await waitFor(() => q.idle() && r.idle(), 2000, 'calls to finish');
  p.noErrors(); q.noErrors(); r.noErrors();
});

test("when the Sheet doesn't answer and nothing is kept: the Linktree note, no events, and Continue still signs in", async t => {
  const p = await openPage(t, (w, g, api) => { api.fail = 'getPublic'; }, await seededSheet(t));
  assert.equal(p.$('#nextup').textContent, FAIL);
  const link = p.$('#nextup a');
  assert.equal(link.getAttribute('href'), 'https://linktr.ee/eastbaypermacultureguild');
  assert.equal(link.target, '_blank');
  assert.ok(!p.$('.nxcard') && !p.$('#hero-cards .art') && !p.shown('#hero-cards'), 'no events, and no card fan');
  assert.ok(p.shown('#hero-note') && p.$('#hero-note').textContent === FAIL);
  assert.equal(p.$('#nextstrip').className, 'nextstrip note warn');
  assert.match(p.$('#nextstrip').textContent, /^We couldn't load the latest dates\./);
  assert.equal(p.$('#nextstrip a').getAttribute('href'), 'https://linktr.ee/eastbaypermacultureguild');
  for (const s of STARTER) assert.ok(!drawn(p).includes(s), s + ' is not on the page');
  assert.ok(!p.$('[aria-busy]') && !p.$('.sk'), 'not loading any more');
  // the sign-in card has no names to show, so Continue checks the code and brings them
  p.$('#signin-top').click();
  assert.equal(p.$('#si-pick .pick-note').textContent, "We couldn't load the organizers' names. Type the code and press Continue, then pick your name.");
  p.set('#si-code', p.code());
  p.$('#si-pick [data-first]').click();
  await waitFor(() => p.$$(NAMES).length, 3000, 'the names from the Sheet');
  assert.deepEqual(p.$$(NAMES).map(b => b.dataset.as), ['Jessie', 'Phil', 'Kalynn', 'Sky']);
  p.$('#si-pick button[data-as="Kalynn"]').click();
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 3000, 'the events page');
  assert.equal(p.$('#who > span:last-child').textContent, 'Signed in as Kalynn · Co-organizer');
  assert.deepEqual(p.api.calls.filter(c => c === 'signIn' || c === 'seed'), ['signIn'], 'one sign-in call, and no seed');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test("with the server out of reach and nothing kept, the page shows the Linktree note and no events", async t => {
  const p = await openPage(t, (w, g, api) => {
    const send = w.fetch;
    w.fetch = (url, opts) => /"fn":"getPublic"/.test(String(opts && opts.body)) ? (api.calls.push('getPublic'), w.Promise.reject(new w.TypeError('Failed to fetch'))) : send(url, opts);
  }, await seededSheet(t));
  assert.equal(p.$('#nextup').textContent, FAIL);
  assert.ok(!p.$('.nxcard') && !p.shown('#hero-cards') && p.shown('#hero-note'));
  assert.equal(p.w.localStorage.getItem(CACHE), null, 'nothing kept from a failed read');
  for (const s of STARTER) assert.ok(!drawn(p).includes(s), s + ' is not on the page');
  p.noErrors();
});

/* ---------- the public event page (?ev=ID) ---------- */
const W7_TL = [['9:45 AM', 'Arrivals and nametags'], ['10:15 AM', 'Intro and ice breaker'], ['10:45 AM', 'Garden work'], ['12:30 PM', 'Lunch'], ['12:50 PM', 'Debrief in small groups']];
// what only organizers may see: the plan's leads-only rows, roles, tasks, food, supplies, garden areas, notes, the ice breaker
const PLAN_ONLY = ['hard out', 'Leads set up', 'Phil', 'Kalynn', 'Karen', 'Meena', 'Make a parking sign', 'Plates, cups', 'pride of Madeira', 'oak guild', 'What are you planting', 'Greenhouse and guild boxes', 'Nametags and markers'];
const blobText = (w, b) => new Promise((ok, no) => { const r = new w.FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsText(b); });
async function eventPage(t, id, before, sheet) {
  const p = loadPage(t, SITE, URL_SITE + '?ev=' + id, before, sheet || await seededSheet(t));
  await waitFor(() => p.api.calls.includes('getPublic') && p.idle() && !p.$('#p-pubevent').hasAttribute('aria-busy'), 4000, 'the event page to load');
  return p;
}
const setEvCell = (g, id, head, v) => { const tab = g.tab('Events'); g.sheets.get('Events').set(tab.findIndex(r => r[0] === id) + 1, tab[0].indexOf(head) + 1, v); delete g.cache['public:v1']; };

test("an event link (?ev=w7) shows a visitor the event's own page: when, where with Directions, what to expect, and nothing from the plan", async t => {
  const p = await eventPage(t, 'w7');
  assert.ok(p.shown('#p-pubevent') && !p.shown('#p-landing') && !p.shown('#p-signin'), 'the event page, not the home page or the sign-in card');
  assert.ok(p.d.body.classList.contains('out'));
  assert.equal(p.$('#pe-title').textContent, 'OPC Garden Work Party');
  assert.equal(p.d.title, 'OPC Garden Work Party · East Bay Permaculture Guild');
  assert.deepEqual(p.$$('.pe-k > span').map(s => s.textContent), ['Work party', 'Tomorrow']);
  assert.deepEqual(p.$$('.pe-facts li').map(li => [...li.querySelector('span').children].map(x => x.textContent)),
    [['Sunday, October 25', '10:00 AM–2:00 PM'], ['Oakland Peace Center', '111 Fairmount Ave, Oakland', 'Directions']]);
  const dir = p.$('#pe-dir');
  assert.equal(dir.getAttribute('href'), 'https://maps.app.goo.gl/9jQkydC38eJrRScr6', "the Guild's own map link");
  assert.deepEqual([dir.target, dir.rel], ['_blank', 'noopener']);
  assert.deepEqual(p.$$('.pe-about p').map(x => x.textContent), [
    'Our monthly garden work day at the Oakland Peace Center. We pick up where Workday #6 left off, then share lunch and a short debrief. No experience needed.',
    'What to bring: water bottle, gloves if you have them',
    'No experience needed, tools and gloves provided, bring a dish to share if you can.']);
  assert.equal(p.$('#pe-first-h').textContent, "First time? Here's how it goes");
  assert.deepEqual(p.$$('.pe-tl li').map(li => [...li.children].map(x => x.textContent)), W7_TL, "the public timeline, without the leads' own rows");
  assert.deepEqual(p.$$('.pe-tips li').map(li => li.textContent), ['Wear closed-toe shoes and bring water.', "Look for Jessie, who's hosting."]);
  assert.equal(p.$('#pe-join').textContent, "I'm new: sign me up");
  assert.ok(!p.$('#pe-rsvp'), 'no RSVP link until one is set');
  assert.equal(p.$('#pe-org').textContent, 'Organizer? Open the plan');
  const html = p.$('#p-pubevent').innerHTML;
  for (const s of PLAN_ONLY) assert.ok(!html.includes(s), s + ' is not on the public page');
  assert.ok(!p.$('#p-landing [data-signin], [data-signin]'), 'nothing sends visitors to the sign-in page');
  checkIcons(p, 'the public event page');
  assert.deepEqual(p.$$('.pe-facts .ic-chip use').map(u => u.getAttribute('href')), ['#i-calendar', '#i-map-pin']);
  assert.deepEqual(['#pe-join', '#pe-gcal', '#pe-ics', '#pe-copy', '#pe-wa', '#pe-org', '.pe-back'].map(s => p.$(s + ' use').getAttribute('href')),
    ['#i-user-plus', '#i-calendar-plus', '#i-download', '#i-link', '#i-message-circle', '#i-lock', '#i-arrow-left']);
  p.noErrors();
});

test('Add to Google Calendar and Download .ics give Oakland time; Copy link and WhatsApp share the page', async t => {
  const p = await eventPage(t, 'w7');
  const cal = p.$('#pe-gcal').getAttribute('href');
  assert.ok(cal.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE&text=OPC%20Garden%20Work%20Party&'), cal);
  assert.ok(cal.includes('&dates=20261025T100000/20261025T140000&'), 'the dates, in local time');
  assert.ok(cal.includes('&ctz=America/Los_Angeles&'), "in Oakland's time zone");
  const q = new URL(cal).searchParams;
  assert.equal(q.get('location'), 'Oakland Peace Center, 111 Fairmount Ave, Oakland');
  assert.match(q.get('details'), /^Our monthly garden work day[^]*\n\nWhat to bring: water bottle, gloves if you have them\n\nDetails and directions: http:\/\/localhost:8766\/site\?ev=w7$/);
  assert.deepEqual([p.$('#pe-gcal').target, p.$('#pe-gcal').rel], ['_blank', 'noopener']);

  p.$('#pe-ics').click();
  const dl = await waitFor(() => p.api.downloads[0], 2000, 'the .ics download');
  assert.equal(dl.name, 'ebpg-2026-10-25-opc-garden-work-party.ics');
  assert.match(dl.href, /^blob:/);
  assert.equal(dl.blob.type, 'text/calendar;charset=utf-8');
  const ics = await blobText(p.w, dl.blob);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  const lines = ics.split('\r\n').slice(0, -1);
  assert.ok(lines.every(l => Buffer.byteLength(l) <= 75), 'every line folded to 75 bytes');
  const flat = ics.replace(/\r\n /g, ''); // unfolded
  for (const l of ['BEGIN:VEVENT', 'UID:w7@ebpg-event-hub', 'DTSTART;TZID=America/Los_Angeles:20261025T100000', 'DTEND;TZID=America/Los_Angeles:20261025T140000',
    'SUMMARY:OPC Garden Work Party', 'LOCATION:Oakland Peace Center\\, 111 Fairmount Ave\\, Oakland', 'URL:http://localhost:8766/site?ev=w7', 'TZID:America/Los_Angeles', 'END:VEVENT']) {
    assert.ok(flat.split('\r\n').includes(l), l);
  }
  assert.match(flat, /\r\nDTSTAMP:2026102\dT\d{6}Z\r\n/);
  assert.match(flat, /\r\nDESCRIPTION:Our monthly garden work day at the Oakland Peace Center\. We pick up where Workday #6 left off\\, then share lunch and a short debrief\. No experience needed\.\\n\\nWhat to bring: water bottle\\, gloves if you have them\\n\\nDetails and directions: http:\/\/localhost:8766\/site\?ev=w7\r\n/,
    'commas and new lines escaped');

  // no share sheet on this browser: Copy link, and WhatsApp
  assert.ok(!p.$('#pe-share'));
  p.$('#pe-copy').click();
  await waitFor(() => p.api.copied.length, 2000, 'the copied link');
  assert.deepEqual(p.api.copied, ['http://localhost:8766/site?ev=w7']);
  await waitFor(() => p.api.toasts.includes('Link copied'), 2000, 'Link copied');
  assert.equal(p.$('#pe-wa').getAttribute('href'), 'https://wa.me/?text=' + encodeURIComponent('OPC Garden Work Party: Sunday, October 25, 10am, Oakland Peace Center. With the East Bay Permaculture Guild. http://localhost:8766/site?ev=w7'));
  assert.deepEqual([p.$('#pe-wa').target, p.$('#pe-wa').rel], ['_blank', 'noopener']);
  checkIcons(p, 'save and share');
  p.noErrors();
});

test("on a phone with a share sheet, Share uses it; an RSVP link shows as Also on Partiful; values from the Sheet stay text", async t => {
  const sheet = await seededSheet(t);
  setEvCell(sheet, 'w7', 'rsvp link', 'https://partiful.com/e/abc123');
  setEvCell(sheet, 'w7', 'title', 'Dig & <b>weed</b>, "together"');
  const shared = [];
  let refuse = '';
  const p = await eventPage(t, 'w7', w => {
    Object.defineProperty(w.navigator, 'share', { configurable: true, value: async d => { if (refuse) throw new w.DOMException('no', refuse); shared.push(d); } });
  }, sheet);
  assert.equal(p.$('#pe-title').textContent, 'Dig & <b>weed</b>, "together"', 'shown as typed, not as markup');
  assert.ok(!p.$('#p-pubevent b b, #pe-title b'));
  const rsvp = p.$('#pe-rsvp');
  assert.equal(rsvp.textContent, 'Also on Partiful');
  assert.equal(rsvp.getAttribute('href'), 'https://partiful.com/e/abc123');
  assert.ok(rsvp.querySelector('use[href="#i-out"]'), 'with the opens-elsewhere icon');
  assert.ok(p.$('#pe-share') && !p.$('#pe-copy') && !p.$('#pe-wa'), 'one Share button');
  p.$('#pe-share').click();
  await waitFor(() => shared.length, 2000, 'the share sheet');
  assert.deepEqual(JSON.parse(JSON.stringify(shared[0])), { title: 'Dig & <b>weed</b>, "together"', text: 'Dig & <b>weed</b>, "together": Sunday, October 25, 10am, Oakland Peace Center. With the East Bay Permaculture Guild.', url: 'http://localhost:8766/site?ev=w7' });
  refuse = 'AbortError'; // closing the share sheet
  p.$('#pe-share').click();
  await sleep(50);
  assert.deepEqual(p.api.copied, [], 'closing the sheet copies nothing');
  refuse = 'NotAllowedError'; // a browser that won't share from here
  p.$('#pe-share').click();
  await waitFor(() => p.api.copied.length, 2000, 'the link copied instead');
  assert.deepEqual(p.api.copied, ['http://localhost:8766/site?ev=w7']);
  // a link that isn't Partiful, and one that isn't https, which never gets through
  setEvCell(sheet, 'w7', 'rsvp link', 'https://www.eventbrite.com/e/123');
  const q = await eventPage(t, 'w7', null, sheet);
  assert.equal(q.$('#pe-rsvp').textContent, 'Also on Eventbrite');
  setEvCell(sheet, 'w7', 'rsvp link', 'javascript:alert(1)');
  const r = await eventPage(t, 'w7', null, sheet);
  assert.ok(!r.$('#pe-rsvp') && !r.$('#p-pubevent').innerHTML.includes('javascript'));
  p.noErrors(); q.noErrors(); r.noErrors();
});

test("a draft, a past, or an unknown event's link says it isn't on the calendar anymore, with the next events", async t => {
  const sheet = await seededSheet(t);
  for (const id of ['m2', 'w6', 'nope', '<img src=x onerror=alert(1)>']) {
    const p = await eventPage(t, encodeURIComponent(id), null, sheet);
    assert.ok(p.shown('#p-pubevent'), id);
    assert.equal(p.$('.pe-gone h1').textContent, "This event isn't on the calendar anymore", id);
    assert.equal(p.$('.pe-gone > p').textContent, "It may have moved, or it's already happened. Here's what's coming up next.");
    assert.deepEqual(p.$$('.pe-gone a.nxcard').map(a => a.dataset.ev), ['w7'], 'the next published events');
    assert.equal(p.d.title, 'East Bay Permaculture Guild');
    const html = p.$('#p-pubevent').innerHTML;
    for (const s of ['OPC Community Meeting', 'seed library', 'Workday #6', 'oak guild', '<img']) assert.ok(!html.includes(s), `${s} is not shown for ${id}`);
    checkIcons(p, 'not on the calendar');
    p.noErrors();
  }
  // its cards open the next event here
  const p = await eventPage(t, 'm2', null, sheet);
  p.$('.pe-gone a.nxcard').click();
  assert.equal(p.$('#pe-title').textContent, 'OPC Garden Work Party');
  assert.equal(p.w.location.search, '?ev=w7');
  p.w.history.back();
  await waitFor(() => p.$('.pe-gone'), 2000, 'Back to the note');
  p.$('.pe-gone [data-pe="home-top"]').click();
  assert.ok(p.shown('#p-landing') && !p.shown('#p-pubevent'));
  assert.equal(p.w.location.pathname + p.w.location.search + p.w.location.hash, '/site#welcome');
  // nothing published at all: Next dates coming soon, with the volunteer list
  const empty = await eventPage(t, 'w7', null, makeGas({ now: START, settings: { ORGANIZER_CODE: 'garden-test-2468' } }));
  assert.equal(empty.$('.pe-gone > p').textContent, "Next dates coming soon. Join the list and we'll tell you.");
  empty.$('.pe-gone [data-pe="joinlist"]').click();
  assert.ok(empty.shown('#p-landing') && empty.$('#vj-for').hidden, 'the volunteer form, for no event in particular');
  assert.equal(empty.d.activeElement, empty.$('#vj-name'));
  p.noErrors(); empty.noErrors();
});

test("while the Sheet wakes up an event link shows grey shapes, never not-found; if it doesn't answer, the Linktree", async t => {
  const sheet = await seededSheet(t);
  const p = loadPage(t, SITE, URL_SITE + '?ev=w7', (w, g, api) => { api.latency = 400; }, sheet);
  assert.ok(p.shown('#p-pubevent'));
  assert.equal(p.$('#p-pubevent').getAttribute('aria-busy'), 'true');
  assert.match(p.$('#p-pubevent').textContent, /Loading event…/);
  assert.ok(p.$('#p-pubevent .sk') && !p.$('.pe-gone'), 'grey shapes, not "not on the calendar"');
  await waitFor(() => p.$('#pe-title'), 3000, 'the event');
  assert.ok(!p.$('#p-pubevent').hasAttribute('aria-busy') && !p.$('#p-pubevent .sk'));
  // the last visit's answer: shown at once when it has the event; grey shapes while the Sheet says whether a newer one is there
  const kept = JSON.stringify({ at: 0, st: sheet.ctx.getPublic() });
  setEvCell(sheet, 'm2', 'status', 'published');
  const q = loadPage(t, SITE, URL_SITE + '?ev=w7', (w, g, api) => { w.localStorage.setItem(CACHE, kept); api.latency = 300; }, sheet);
  assert.equal(q.$('#pe-title').textContent, 'OPC Garden Work Party', 'at once, from the last visit');
  const r = loadPage(t, SITE, URL_SITE + '?ev=m2', (w, g, api) => { w.localStorage.setItem(CACHE, kept); api.latency = 300; }, sheet);
  assert.ok(r.$('#p-pubevent .sk') && !r.$('.pe-gone'), 'not in the last answer: wait for the Sheet');
  await waitFor(() => r.$('#pe-title'), 3000, 'Community Meeting #2, published since');
  assert.equal(r.$('#pe-title').textContent, 'OPC Community Meeting');
  // the Sheet doesn't answer, and nothing kept
  const f = loadPage(t, SITE, URL_SITE + '?ev=w7', (w, g, api) => { api.fail = 'getPublic'; }, sheet);
  await waitFor(() => f.$('.pe-gone.warn'), 3000, 'the note');
  assert.equal(f.$('.pe-gone h1').textContent, "We couldn't load this event");
  assert.equal(f.$('.pe-gone a[target=_blank]').getAttribute('href'), 'https://linktr.ee/eastbaypermacultureguild');
  // and it shows once the Sheet answers, when the visitor comes back to the tab
  f.api.fail = '';
  f.d.dispatchEvent(new f.w.Event('visibilitychange'));
  await waitFor(() => f.$('#pe-title'), 3000, 'the event');
  await waitFor(() => p.idle() && q.idle() && r.idle() && f.idle(), 2000, 'calls to finish');
  p.noErrors(); q.noErrors(); r.noErrors(); f.noErrors();
});

test('the landing cards, the Next up strip and the hero open the event page in place; Back goes home again', async t => {
  const p = await openPage(t, null, await seededSheet(t));
  assert.ok(!p.$('#p-landing [data-signin]'), 'no landing element sends people to sign in');
  const hero = p.$('#hero-cards a.hero-go');
  assert.deepEqual([hero.getAttribute('href'), hero.getAttribute('tabindex'), p.$('#hero-cards').getAttribute('aria-hidden')], ['?ev=w7', '-1', 'true'], 'the card fan is a link for the mouse (keyboards use the cards)');
  const calls = p.api.calls.length;
  p.$('#nextup a.nxcard').click();
  assert.ok(p.shown('#p-pubevent') && !p.shown('#p-landing'), 'the event page');
  assert.equal(p.$('#pe-title').textContent, 'OPC Garden Work Party');
  assert.equal(p.w.location.search, '?ev=w7', 'with its own address');
  assert.equal(p.d.activeElement, p.$('#pe-title'), 'focus on its heading, for screen readers');
  assert.equal(p.api.calls.length, calls, 'without asking the Sheet again');
  p.w.history.back();
  await waitFor(() => p.shown('#p-landing'), 2000, 'Back to the home page');
  assert.equal(p.w.location.search, '');
  assert.equal(p.d.title, 'East Bay Permaculture Guild');
  p.w.history.forward();
  await waitFor(() => p.shown('#p-pubevent'), 2000, 'Forward to the event');
  // All upcoming events: home, at the list
  p.$('.pe-back').click();
  assert.ok(p.shown('#p-landing'));
  assert.equal(p.w.location.pathname + p.w.location.search + p.w.location.hash, '/site#meet');
  assert.equal(p.d.activeElement, p.$('#meet h2'));
  p.$('#nextstrip a.nsgo').click();
  assert.ok(p.shown('#p-pubevent'), 'the Next up strip');
  p.$('.pe-back').click();
  p.$('#hero-cards a.hero-go').click();
  assert.ok(p.shown('#p-pubevent'), 'the hero');
  // a click with Cmd or Ctrl is left to the browser (a new tab)
  p.$('.pe-back').click();
  const e = new p.w.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
  p.$('#nextup a.nxcard').dispatchEvent(e);
  assert.ok(p.shown('#p-landing'));
  p.noErrors();
});

test("I'm new: sign me up goes to the volunteer form, which says which event; its x clears it", async t => {
  const p = await eventPage(t, 'w7');
  p.$('#pe-join').click();
  assert.ok(p.shown('#p-landing') && !p.shown('#p-pubevent'));
  assert.equal(p.w.location.pathname + p.w.location.search + p.w.location.hash, '/site#join');
  assert.equal(p.$('#vj-ev').value, 'w7', 'the event, in a hidden field');
  assert.equal(p.$('#vj-ev').type, 'hidden');
  assert.ok(!p.$('#vj-for').hidden);
  assert.equal(p.$('#vj-for > span').textContent, 'Coming to OPC Garden Work Party');
  assert.ok(p.$('#vj-for use[href="#i-calendar"]'));
  assert.equal(p.d.activeElement, p.$('#vj-name'), 'ready to type a name');
  checkIcons(p, 'the Coming to chip');
  p.w.history.back();
  await waitFor(() => p.shown('#p-pubevent'), 2000, 'Back to the event');
  p.$('#pe-join').click();
  const x = p.$('#vj-for-x');
  assert.equal(x.getAttribute('aria-label'), 'Clear "Coming to OPC Garden Work Party"');
  x.click();
  assert.ok(p.$('#vj-for').hidden);
  assert.equal(p.$('#vj-ev').value, '');
  assert.equal(p.d.activeElement, p.$('#vj-name'));
  // the sign-up still goes through
  p.set('#vj-name', 'Maya Ortiz'); p.set('#vj-contact', 'maya@example.org');
  p.$('#vj-picks input').click();
  p.$('#joinf button[type=submit]').click();
  await waitFor(() => p.g.tab('Volunteers').some(r => r.includes('Maya Ortiz')), 3000, 'the sign-up');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test("Organizer? Open the plan: sign in from an event's page and its plan opens; signed in, ?ev= opens the plan; a draft's link can't be copied", async t => {
  const sheet = await seededSheet(t);
  const p = await eventPage(t, 'w7', null, sheet);
  p.$('#pe-org').click();
  assert.ok(p.shown('#p-signin'));
  assert.equal(p.$('#si-back').textContent, 'Back to the event');
  p.$('#si-back').click();
  assert.ok(p.shown('#p-pubevent') && p.$('#pe-title'), 'back to the event');
  p.$('#pe-org').click();
  p.set('#si-code', p.code());
  p.$('#si-pick button[data-as="Jessie"]').click();
  await waitFor(() => p.shown('#p-event') && p.$('#detail #dp-plan') && !p.d.body.classList.contains('out'), 3000, "Workday #7's plan");
  assert.match(p.$('#detail .dh h2').textContent, /OPC Garden Work Party/);
  assert.equal(p.d.title, 'East Bay Permaculture Guild', 'the title is the site again');
  const copy = p.$('#ev-copy');
  assert.ok(!copy.disabled && !copy.title, 'a published event can be shared');
  copy.click();
  await waitFor(() => p.api.copied.length, 2000, 'the copied link');
  assert.deepEqual(p.api.copied, ['http://localhost:8766/site?ev=w7'], 'the same link the public uses');
  // the pop-up has Copy link too: off for a draft
  p.$('#ev-back').click();
  p.$('#tiles [data-open="m2"]').click();
  await waitFor(() => p.shown('#modal') && p.$('#detail #dp-plan'), 2000, 'the pop-up');
  const mc = p.$('#m-copy');
  assert.ok(!mc.hidden && mc.disabled && mc.querySelector('use[href="#i-link"]'));
  assert.equal(mc.title, 'Publish it first to share');
  p.$('#m-x').click();
  p.$('#tiles [data-open="w7"]').click();
  await waitFor(() => p.shown('#modal') && !p.$('#m-copy').disabled, 2000, 'the pop-up for Workday #7');
  p.$('#m-copy').click();
  await waitFor(() => p.api.copied.length === 2, 2000, 'the copied link');
  assert.equal(p.api.copied[1], 'http://localhost:8766/site?ev=w7');
  p.$('#m-x').click();
  await waitFor(p.idle, 2000, 'calls to finish');
  // signed out from there, the site is home again (no ?ev=)
  p.$('#signout').click();
  assert.ok(p.shown('#p-landing'));
  assert.equal(p.w.location.search, '');
  p.noErrors();

  // an organizer signed in on this device who opens ?ev= gets the plan, as before; a draft's Copy link is turned off
  const q = loadPage(t, SITE, URL_SITE + '?ev=m2', withCode('tab', 'Phil'), sheet);
  assert.ok(q.shown('#p-resume') && !q.shown('#p-pubevent'), 'signing back in, not the public page');
  await waitFor(() => q.shown('#p-event') && q.$('#detail #dp-plan'), 4000, "Community Meeting #2's plan");
  const qc = q.$('#ev-copy');
  assert.ok(qc.disabled);
  assert.equal(qc.title, 'Publish it first to share');
  assert.equal(qc.getAttribute('aria-disabled'), 'true');
  qc.click();
  assert.deepEqual(q.api.copied, [], 'nothing copied');
  q.$('#publish-ev').click();
  assert.ok(!q.$('#ev-copy').disabled && !q.$('#ev-copy').title, 'published: it can be shared');
  await waitFor(q.idle, 3000, 'calls to finish');
  q.noErrors();
});

test('share previews: Open Graph and Twitter tags, a canonical link, and og.jpg next to the page', () => {
  const live = fs.readFileSync(SITE, 'utf8'), head = live.slice(0, live.indexOf('<script>'));
  const meta = (attr, k) => (head.match(new RegExp(`<meta ${attr}="${k.replace(/[:.]/g, '\\$&')}" content="([^"]*)">`)) || [])[1];
  const desc = meta('name', 'description');
  assert.equal(desc, 'Garden work days, monthly potlucks and volunteer sign-up for the East Bay Permaculture Guild in Oakland.');
  assert.equal(meta('property', 'og:title'), 'East Bay Permaculture Guild');
  assert.equal(meta('property', 'og:description'), desc, 'the same as the description');
  assert.equal(meta('property', 'og:image'), 'https://ebpg-event-hub.netlify.app/og.jpg');
  assert.equal(meta('property', 'og:url'), 'https://ebpg-event-hub.netlify.app/');
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.ok(head.includes('<link rel="canonical" href="https://ebpg-event-hub.netlify.app/">'));
  const og = path.join(path.dirname(SITE), 'og.jpg');
  assert.ok(fs.existsSync(og), 'site/og.jpg');
  assert.ok(fs.readFileSync(og).equals(fs.readFileSync(path.join(path.dirname(ARTIFACT), 'assets', 'trellis.jpg'))), 'the trellis photo');
});

test('the event page fits a phone: one column under 860px, no art under 600px, 44px tap targets', () => {
  const css = fs.readFileSync(SITE, 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /@media \(max-width: 860px\) \{ \.pe \{ grid-template-columns: 1fr;/);
  assert.match(css, /@media \(max-width: 600px\) \{ \.pe-art \{ display: none; \} \}/);
  assert.match(css, /\.pe-save \.btn \{[^}]*width: 100%; white-space: normal;[^}]*min-height: 44px;/);
  assert.match(css, /\.pe-back \{[^}]*min-height: 44px;/);
  for (const sel of ['.pe h1', '.pe-facts li > span', '.pe-about', '.pe-tl li']) assert.match(css, new RegExp(sel.replace(/[.>]/g, '\\$&') + ' \\{[^}]*overflow-wrap: anywhere'), sel + ' wraps long words');
});

test("when the Sheet doesn't answer: last visit's events stay on show, and coming back to the tab tries again", async t => {
  const sheet = await seededSheet(t);
  const kept = JSON.stringify({ at: 0, st: sheet.ctx.getPublic() });
  const p = await openPage(t, (w, g, api) => { w.localStorage.setItem(CACHE, kept); api.fail = 'getPublic'; }, sheet);
  assert.deepEqual(p.$$('#nextup a.nxcard').map(a => a.dataset.ev), ['w7'], 'the kept events');
  assert.ok(!drawn(p).includes("couldn't load") && !p.shown('#hero-note'), 'no failure note while there are events to show');
  assert.equal(p.$('#nextstrip .nsb b').textContent, 'OPC Garden Work Party');
  // nothing kept, nothing to show: the note, until the Sheet answers again
  const q = await openPage(t, (w, g, api) => { api.fail = 'getPublic'; }, sheet);
  assert.equal(q.$('#nextup').textContent, FAIL);
  q.api.fail = '';
  q.d.dispatchEvent(new q.w.Event('visibilitychange'));
  await waitFor(() => q.$('#nextup a.nxcard'), 3000, 'the events once the Sheet answers');
  assert.ok(!q.shown('#hero-note') && q.$$('#hero-cards .art').length === 3);
  assert.deepEqual(q.$$(NAMES).map(b => b.dataset.as), ['Jessie', 'Phil', 'Kalynn', 'Sky']);
  assert.equal(q.api.calls.filter(c => c === 'getPublic').length, 2);
  await waitFor(() => p.idle() && q.idle(), 2000, 'calls to finish');
  p.noErrors(); q.noErrors();
});

test("a Sheet nobody has set up: Next dates coming soon, and Continue fills it, then the names come from the Sheet", async t => {
  const p = await openPage(t);
  assert.equal(p.$('#nextup').textContent, SOON);
  assert.equal(p.$('#nextup a').getAttribute('href'), '#join');
  assert.ok(p.shown('#hero-note') && !p.shown('#hero-cards'), 'a note in place of the card fan');
  assert.equal(p.$('#hero-note').textContent, SOON);
  assert.equal(p.$('#hero-note a').getAttribute('href'), '#join');
  assert.equal(p.$('#nextstrip').className, 'nextstrip note');
  assert.match(p.$('#nextstrip').textContent, /^Next dates coming soon\./);
  assert.equal(p.$('#nextstrip a').getAttribute('href'), '#join');
  for (const s of STARTER) assert.ok(!drawn(p).includes(s), s + ' is not on the page');
  // sign in: no names yet
  p.$('#signin-top').click();
  assert.deepEqual(p.$$('#si-pick button').map(b => b.dataset.as), [''], 'only Continue');
  const cont = p.$('#si-pick [data-first]');
  assert.equal(cont.textContent, 'ContinueCheck the code');
  assert.ok(cont.querySelector('use[href="#i-log-in"]'));
  assert.equal(p.$('#si-pick .pick-note').textContent, 'The Guild Sheet has no organizers yet. Type the code and press Continue to set it up, then pick your name.');
  checkIcons(p, 'sign-in with Continue');
  cont.click();
  assert.equal(p.$('#si-err').textContent, 'Type the organizer code first.');
  // the Sheet answers with an HTML error page: try again
  p.set('#si-code', p.code());
  p.api.fail = 'signIn';
  cont.click();
  await waitFor(() => p.shown('#si-err'), 3000, 'the sign-in error');
  assert.equal(p.$('#si-err').textContent, "The Guild Sheet didn't answer. Check your internet, then press Continue to try again.");
  p.api.fail = ''; p.api.latency = 200;
  p.$('#si-pick [data-first]').click();
  assert.equal(p.$('#si-pick [data-first]').getAttribute('aria-busy'), 'true');
  assert.match(p.$('#si-pick [data-first]').textContent, /Signing in…$/);
  await waitFor(() => p.api.out.seed === 1, 3000, 'the Sheet to be filled');
  assert.equal(p.$('#si-wait').textContent, 'Setting up the Guild Sheet for the first time. This can take up to a minute.');
  await waitFor(() => p.$$(NAMES).length, 3000, 'the names from the Sheet');
  assert.deepEqual(p.$$(NAMES).map(b => b.dataset.as), ['Jessie', 'Phil', 'Kalynn', 'Sky']);
  assert.ok(p.$$(NAMES).every(b => !b.disabled && !b.hasAttribute('aria-busy')), 'ready to pick');
  assert.equal(p.$('#si-wait').textContent, 'The Guild Sheet is ready. Pick your name.');
  assert.equal(p.d.activeElement, p.$('#si-pick button[data-as="Jessie"]'), 'focus on the first name');
  assert.ok(p.d.body.classList.contains('out') && p.shown('#p-signin'), 'not signed in until a name is picked');
  // picking a name finishes at once: the Sheet has already answered
  p.$('#si-pick button[data-as="Phil"]').click();
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 2000, 'the events page');
  assert.equal(p.$('#who > span:last-child').textContent, 'Signed in as Phil · Co-organizer');
  assert.deepEqual(p.api.calls.filter(c => c === 'signIn' || c === 'seed'), ['signIn', 'signIn', 'seed'], 'no third sign-in call for the name');
  assert.equal(p.$('#si-wait').textContent, '');
  // signed out again, the landing page has the Sheet's published events
  p.$('#signout').click();
  assert.deepEqual(p.$$('#nextup a.nxcard').map(a => a.dataset.ev), ['w7']);
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('the built page has no made-up meeting, and phones get the Next up strip in place of the card fan', () => {
  const live = fs.readFileSync(SITE, 'utf8'), src = fs.readFileSync(ARTIFACT, 'utf8');
  for (const s of ['Grace Room', 'Guild Monthly Meeting', '2nd Monday', 'nextSecondMonday', 'data-signin']) {
    assert.ok(!live.includes(s), s + ' is not in site/index.html');
    assert.ok(!src.includes(s), s + ' is not in event-hub/src.html');
  }
  const css = live.slice(live.indexOf('<style>'), live.indexOf('</style>'));
  const block = w => { const i = css.indexOf(`@media (max-width: ${w}px) {\n`); assert.ok(i >= 0, `a ${w}px block`); return css.slice(i, css.indexOf('\n}', i)); };
  assert.match(block(600), /\.scene \{ display: none; \}/, 'no card fan under 600px');
  assert.match(block(600), /\.nextstrip \{ position: relative; display: flex;/, 'the Next up strip instead');
  assert.match(css, /\.nextstrip \{ display: none; \}/, 'and only there');
  assert.match(block(400), /\.lock b \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip:/, 'under 400px the mark alone, the name kept for screen readers');
});

test('the prototype artifact draws its own events at once, with the same cards, and an event link opens its page (#pub-ID)', async t => {
  const p = loadPage(t, ARTIFACT, 'http://localhost/artifact');
  await waitFor(() => p.shown('#p-landing'), 2000, 'the artifact landing page');
  assert.ok(!p.$('.skel, .sk, [aria-busy]'), 'no grey shapes');
  assert.deepEqual(p.$$('#nextup a.nxcard').map(a => [a.getAttribute('href'), a.querySelector('.soon').textContent]), [['#pub-w7', 'Tomorrow']]);
  assert.deepEqual([...p.$('#nextup .nb').children].map(x => x.textContent), ['Work party', 'OPC Garden Work Party', 'Sunday, October 25 · 10:00 AM', 'Oakland Peace Center']);
  assert.equal(p.$$('#hero-cards .art').length, 3);
  assert.equal(p.$('#nextstrip .nsk').textContent, 'Next up · Tomorrow');
  assert.deepEqual(p.$$('#si-pick button').map(b => b.dataset.as), ['Jessie', 'Phil', 'Kalynn', 'Sky']);
  p.$('#nextup a.nxcard').click();
  assert.ok(p.shown('#p-pubevent') && !p.shown('#p-landing'), 'the event page');
  assert.equal(p.w.location.hash, '#pub-w7');
  assert.equal(p.$('#pe-title').textContent, 'OPC Garden Work Party');
  assert.deepEqual(p.$$('.pe-tl li').map(li => [...li.children].map(x => x.textContent)), W7_TL, 'drawn from the public fields of the in-memory event');
  assert.deepEqual(p.$$('.pe-tips li').map(li => li.textContent), ['Wear closed-toe shoes and bring water.', "Look for Jessie, who's hosting."]);
  const html = p.$('#p-pubevent').innerHTML;
  for (const s of PLAN_ONLY) assert.ok(!html.includes(s), s + ' is not on the public page');
  const cal = p.$('#pe-gcal').getAttribute('href');
  assert.ok(cal.includes('dates=20261025T100000/20261025T140000') && cal.includes('ctz=America/Los_Angeles'));
  assert.match(new URL(cal).searchParams.get('details'), /Details and directions: https:\/\/claude\.ai\/artifact\/\w+#pub-w7$/);
  p.$('#pe-ics').click();
  const ics = await blobText(p.w, (await waitFor(() => p.api.downloads[0], 2000, 'the .ics')).blob);
  assert.ok(ics.includes('BEGIN:VCALENDAR') && ics.includes('DTSTART;TZID=America/Los_Angeles:20261025T100000'));
  p.$('.pe-back').click();
  assert.ok(p.shown('#p-landing'));
  // a draft's link, and one that's over, aren't on the calendar
  for (const id of ['m2', 'w6']) {
    const q = loadPage(t, ARTIFACT, 'http://localhost/artifact#pub-' + id);
    assert.equal(q.$('.pe-gone h1').textContent, "This event isn't on the calendar anymore", id);
    assert.ok(!q.$('#p-pubevent').innerHTML.includes('Community Meeting'), id);
    q.noErrors();
  }
  // signing in from an event's page opens its plan
  const r = loadPage(t, ARTIFACT, 'http://localhost/artifact#pub-w7');
  assert.equal(r.$('#pe-title').textContent, 'OPC Garden Work Party');
  r.$('#pe-org').click();
  r.$('#si-google').click();
  assert.ok(r.shown('#p-event') && r.$('#detail #dp-plan'), "Workday #7's plan");
  assert.deepEqual(p.api.calls.concat(r.api.calls), [], 'the artifact calls no server');
  p.noErrors(); r.noErrors();
});

/* ---------- QR codes on the flyers and the garden sign (Flyers & posts) ---------- */
// qrcode-generator 1.4.4 from npm: the same qrcode.js cdnjs serves (its sha512 matches cdnjs's), which the page loads
// minified from cdnjs. jsdom loads no outside scripts, so a page gets it only from withQR; without it, the page is offline.
const QR_LIB = fs.readFileSync(require.resolve('qrcode-generator'), 'utf8');
const QR_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const withQR = (w, g, api) => {
  w.eval(QR_LIB);
  // keep each text the page turns into a code
  const real = w.qrcode;
  api.qr = [];
  w.qrcode = (...a) => { const qr = real(...a), add = qr.addData; qr.addData = (d, m) => { api.qr.push(String(d)); return add.call(qr, d, m); }; return qr; };
};
/* the SVG draws exactly the QR code of `text` (error correction M) with a quiet zone of 2 modules, in currentColor */
function isQrOf(svg, text) {
  assert.ok(svg, 'a QR code for ' + text);
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(svg.getAttribute('aria-label'), 'QR code for ' + text);
  const qr = require('qrcode-generator')(0, 'M');
  qr.addData(text); qr.make();
  const n = qr.getModuleCount();
  assert.equal(svg.getAttribute('viewBox'), `0 0 ${n + 4} ${n + 4}`, 'a quiet zone of 2 modules');
  const path = svg.querySelector('path'), d = path.getAttribute('d'), RUN = /M(\d+) (\d+)h(\d+)v1h-\3z/g;
  assert.equal(path.getAttribute('fill'), 'currentColor');
  assert.equal(d.replace(RUN, ''), '', 'the path is only runs of modules');
  const dark = new Set();
  for (const [, x, y, run] of d.matchAll(RUN)) for (let i = 0; i < +run; i++) dark.add((+x + i) + ',' + y);
  const want = new Set();
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) want.add((c + 2) + ',' + (r + 2));
  assert.deepEqual([...dark].sort(), [...want].sort(), 'the modules are the code of ' + text);
}
const WORKDAY = (g, v) => { g.sheets.get('Settings').set(g.tab('Settings').findIndex(r => r[0] === 'WORKDAY_SCHEDULE') + 1, 2, v); delete g.cache['public:v1']; };
const hostOf = (p, id) => { const ev = p.g.tab('Events'), h = ev[0]; return ev.find(r => r[0] === id)[h.indexOf('host')]; };
const weekday = date => new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
const dateOf = (p, id) => { const ev = p.g.tab('Events'), h = ev[0]; return ev.find(r => r[0] === id)[h.indexOf('date')]; };
async function openFlyers(p, id) {
  p.$('.tabs a[data-tab=materials]').click();
  assert.ok(p.visible('#p-materials'), 'Flyers & posts is shown');
  p.set('#m-ev', id);
  return p.$('#m-event');
}

test('the page loads qrcode-generator 1.4.4 from cdnjs with its integrity hash, and nothing made up is left on the templates', () => {
  for (const [name, html] of [['site/index.html', fs.readFileSync(SITE, 'utf8')], ['event-hub/src.html', fs.readFileSync(ARTIFACT, 'utf8')]]) {
    const tags = html.match(/<script src="[^"]*"[^>]*><\/script>/g) || [];
    assert.deepEqual(tags, [`<script src="${QR_SRC}" integrity="sha512-ZDSPMa/JM1D+7kdg2x3BsruQ6T/JpJo3jWDWkCZsP+5yVyp1KfESqLI+7RqB5k24F7p2cV7i2YHh/890y6P6Sw==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>`], name + ': the one outside script');
    assert.ok(html.indexOf(QR_SRC) < html.indexOf('<style>'), name + ': in the head');
    for (const s of ['QR<br>code', 'Big Mama', 'Nia T.', 'Rosa', '2nd Sundays', 'RSVP on Partiful</span>', 'link on our Linktree</small>']) assert.ok(!html.includes(s), `${s} is not in ${name}`);
  }
});

test('Flyers & posts: the flyer has a real QR code to the event page, a draft says Publish first, and the hero flyer has one too', async t => {
  const p = await openPage(t, withQR, await seededSheet(t));
  const link = URL_SITE + '?ev=w7';
  // signed out: the hero's flyer is the next published event's
  isQrOf(p.$('#hero-cards .art.flyer .ft .qr svg.qrc'), link);
  assert.equal(p.$('#hero-cards .art.flyer .cta').textContent, 'Details and RSVPlocalhost:8766/site?ev=w7');
  await signIn(p);
  const tab = p.$('.tabs a[data-tab=materials]');
  assert.equal(tab.textContent, 'Flyers & posts');
  const gal = await openFlyers(p, 'w7');
  assert.equal(p.$('#p-materials h1').textContent, 'Flyers & posts');
  assert.equal(tab.getAttribute('aria-current'), 'page');
  const ft = gal.querySelector('.art.flyer .ft');
  isQrOf(ft.querySelector('.qr svg.qrc'), link);
  assert.ok(p.api.qr.includes(link), 'the code holds the event page link');
  assert.equal(ft.querySelector('.cta').firstChild.textContent, 'Details and RSVP');
  assert.equal(ft.querySelector('.cta small').textContent, 'localhost:8766/site?ev=w7', 'the short link, without http://');
  assert.equal(gal.querySelector('.art.story .pill').textContent, 'Details: link in bio');
  // a draft has no public page yet
  p.set('#m-ev', 'm2');
  const dft = p.$('#m-event .art.flyer .ft');
  assert.equal(dft.querySelector('.qr.none').textContent, 'Publish to get a QR code');
  assert.ok(dft.querySelector('.qr.none use[href="#i-lock"]'), 'with a lock icon');
  assert.ok(!dft.querySelector('svg.qrc') && !dft.querySelector('.cta small'), 'no code and no link for a draft');
  assert.ok(!p.api.qr.some(x => /ev=m2/.test(x)), 'no code is made for it');
  // its tile cover too, and every published tile's flyer has its own code
  for (const tile of p.$$('#tiles [data-open]')) {
    const id = tile.dataset.open, f = tile.querySelector('.cover .art.flyer .ft');
    if (id === 'm2') assert.equal(f.querySelector('.qr').textContent, 'Publish to get a QR code');
    else isQrOf(f.querySelector('.qr svg.qrc'), URL_SITE + '?ev=' + id);
  }
  checkIcons(p, 'Flyers & posts');
  p.noErrors();
});

test('Flyers & posts, any week: the thank-you card is from the picked event\'s host, and the garden sign has WORKDAY_SCHEDULE and a QR code to #join', async t => {
  const p = await openPage(t, withQR, await seededSheet(t));
  await signIn(p);
  for (const id of ['w7', 'm2']) {
    await openFlyers(p, id);
    const card = p.$('#m-any .art.card5');
    assert.equal(card.querySelector('p').textContent, `Thanks for spending ${weekday(dateOf(p, id))} with us. See you at the next one.`);
    assert.equal(card.querySelector('.sig').textContent, '— ' + hostOf(p, id).split(' ')[0], id + "'s host signs it");
  }
  assert.equal(weekday(dateOf(p, 'w7')), 'Sunday');
  assert.deepEqual(p.$$('#m-any figcaption b').map(b => b.textContent), ['Quote post', 'Thank-you card', 'Garden sign'], 'no plant tag');
  assert.ok(p.$$('#m-any figcaption').every(f => f.querySelector('svg.ic[aria-hidden="true"]')), 'each with its icon');
  const sign = p.$('#m-any .art.sign');
  assert.equal(sign.querySelector('.txt').textContent, '4th Sundays, 10 AM · Oakland Peace Center', 'the Settings tab\'s WORKDAY_SCHEDULE');
  isQrOf(sign.querySelector('.qr svg.qrc'), URL_SITE + '#join');
  assert.equal(sign.querySelector('.qrb .url').textContent, 'localhost:8766/site#join');
  assert.deepEqual([...sign.querySelectorAll('ol li')].map(li => li.textContent), ['Scan the code', 'RSVP to a work day', 'Come say hi']);
  for (const s of ['Big Mama', 'Nia T.', 'Rosa', '2nd Sundays', 'Stewarded plant']) assert.ok(!p.$('#p-materials').textContent.includes(s), s);
  p.noErrors();
});

test('the garden sign follows WORKDAY_SCHEDULE on the Settings tab, even when the page signs straight back in', async t => {
  const sheet = await seededSheet(t);
  const p = loadPage(t, SITE, URL_SITE, (w, g, api) => {
    withCode('tab', 'Phil')(w, g, api);
    withQR(w, g, api);
    WORKDAY(g, '3rd Saturdays, 9 AM');
    // the public answer comes after the sign-in's
    const f = w.fetch;
    w.fetch = (u, o) => /"fn":"getPublic"/.test(String(o && o.body)) ? new w.Promise(r => w.setTimeout(r, 300)).then(() => f(u, o)) : f(u, o);
  }, sheet);
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 4000, 'the events page');
  await waitFor(() => p.api.done.some(c => c.fn === 'getPublic') && p.idle(), 4000, 'the public answer');
  assert.ok(p.api.done.findIndex(c => c.fn === 'signIn') < p.api.done.findIndex(c => c.fn === 'getPublic'), 'signed in first');
  await openFlyers(p, 'w7');
  assert.equal(p.$('#m-any .art.sign .txt').textContent, '3rd Saturdays, 9 AM · Oakland Peace Center');
  p.noErrors();
});

test('without the QR library (offline, or cdnjs blocked): the flyers and the sign show the short link, with no box and no errors', async t => {
  const p = await openPage(t, null, await seededSheet(t));
  assert.equal(typeof p.w.qrcode, 'undefined');
  const hero = p.$('#hero-cards .art.flyer .ft');
  assert.ok(!hero.querySelector('.qr'), 'no box on the hero flyer');
  assert.equal(hero.querySelector('.cta small').textContent, 'localhost:8766/site?ev=w7');
  await signIn(p);
  const ft = (await openFlyers(p, 'w7')).querySelector('.art.flyer .ft');
  assert.ok(!ft.querySelector('.qr, svg.qrc'), 'no box on the flyer');
  assert.equal(ft.querySelector('.cta').textContent, 'Details and RSVPlocalhost:8766/site?ev=w7');
  const sign = p.$('#m-any .art.sign');
  assert.ok(!sign.querySelector('.qr, svg.qrc'), 'no box on the sign');
  assert.equal(sign.querySelector('.qrb.text .url').textContent, 'localhost:8766/site#join');
  assert.deepEqual([...sign.querySelectorAll('ol li')].map(li => li.textContent), ['Go to the link below', 'RSVP to a work day', 'Come say hi']);
  assert.equal(sign.querySelector('.txt').textContent, '4th Sundays, 10 AM · Oakland Peace Center');
  p.noErrors();
});

test("the prototype artifact's flyers and sign point at the public site", async t => {
  const p = loadPage(t, ARTIFACT, 'http://localhost/artifact', withQR);
  await waitFor(() => p.shown('#p-landing'), 2000, 'the artifact landing page');
  isQrOf(p.$('#hero-cards .art.flyer .qr svg.qrc'), 'https://ebpg-event-hub.netlify.app/?ev=w7');
  p.$('#signin-top').click();
  p.$('#si-google').click();
  await openFlyers(p, 'w7');
  const ft = p.$('#m-event .art.flyer .ft');
  isQrOf(ft.querySelector('.qr svg.qrc'), 'https://ebpg-event-hub.netlify.app/?ev=w7');
  assert.equal(ft.querySelector('.cta small').textContent, 'ebpg-event-hub.netlify.app/?ev=w7');
  const sign = p.$('#m-any .art.sign');
  isQrOf(sign.querySelector('.qr svg.qrc'), 'https://ebpg-event-hub.netlify.app/#join');
  assert.equal(sign.querySelector('.url').textContent, 'ebpg-event-hub.netlify.app/#join');
  assert.equal(sign.querySelector('.txt').textContent, '4th Sundays, 10 AM · Oakland Peace Center');
  assert.equal(p.$('#m-any .art.card5 .sig').textContent, '— Jessie');
  assert.deepEqual(p.api.calls, [], 'the artifact calls no server');
  p.noErrors();
});
