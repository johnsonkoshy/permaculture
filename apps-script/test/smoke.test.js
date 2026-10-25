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

/* the volunteer form opened 10 seconds ago: the Sheet ignores one sent within 3 seconds of opening (a bot) */
const settled = p => { p.$('#vj-opened').value = String(p.w.Date.now() - 10000); };

test('the volunteer form adds a row to the Volunteers tab', async t => {
  const p = await openPage(t);
  const submit = () => p.$('#joinf button[type=submit]').click();
  submit();
  assert.ok(p.shown('#vj-err'), 'an empty form shows an error');
  assert.equal(p.g.tab('Volunteers').length, 1, 'nothing saved for an empty form');
  settled(p);
  p.set('#vj-name', 'Sam Rivera');
  p.set('#vj-email', 'sam.rivera@example.org');
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
  'lock', 'mail', 'phone', 'message-circle', 'history', 'eye', 'rotate-ccw', 'printer', 'help-circle', 'download', 'plus', 'check', 'out', 'wand', 'puzzle',
  'calendar-x', 'trash'];
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
  // Workday #7 has no RSVP link yet, so it asks whether this is it; No leaves the event as it is
  const ask = p.$('#dp-out [data-row=partiful] .oask');
  assert.ok(ask && ask.getAttribute('role') === 'group', 'the RSVP question');
  assert.equal(p.d.getElementById(ask.getAttribute('aria-labelledby')).textContent, "Use this as the event's RSVP link?https://partiful.com/e/abc");
  assert.equal(p.d.activeElement.dataset.act, 'rsvp-yes', 'focus moves to Yes');
  p.$('#dp-out [data-act=rsvp-no][data-ch=partiful]').click();
  assert.ok(!p.$('#dp-out .oask'), 'No: the question goes');
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
  const w7Posts = () => p.g.tab('Posts').filter(r => r[0] === 'w7').map(r => r[4]);
  assert.ok(w7Posts().every(x => !x.includes('?ev=')), "a draft's posts don't link to its page, which isn't there now");
  assert.ok(postText(p, 'w7', 'calendar').endsWith('RSVP on Partiful: https://partiful.com/e/seedswap'), 'the RSVP link stays');
  // published again from the form, with the link on the public page
  (await waitFor(() => p.$('#detail #edit-ev'), 2000, 'the event')).click();
  await waitFor(() => p.$('#editf'), 2000, 'the edit form');
  assert.equal(p.$('#ed-rsvp').value, 'https://partiful.com/e/seedswap', 'the link is kept');
  p.$$('#editf input[name=ed-status]')[1].click();
  p.$('#editf button[type=submit]').click();
  await waitFor(() => evCell(p, 'w7', 'status') === 'published', 3000, 'published again');
  await waitFor(() => p.api.toasts.includes("Saved and published. It's on the public site now."), 2000, 'the toast');
  assert.equal(p.g.ctx.getPublic().events[0].rsvp, 'https://partiful.com/e/seedswap');
  assert.ok(postText(p, 'w7', 'calendar').endsWith(URL_SITE + '?ev=w7\nRSVP on Partiful: https://partiful.com/e/seedswap'), 'published, the drafts link to its page again');
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
  settled(p); p.set('#vj-name', 'Maya Ortiz'); p.set('#vj-email', 'maya@example.org');
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

/* ---------- Download (PNG) and Print, on Flyers & posts and in an event's strip of pieces ---------- */
// html-to-image is loaded from cdnjs on the first Download; jsdom loads no outside scripts and can't draw, so a test
// answers the script's load itself with a stand-in that keeps what it was asked to draw and returns a 1-pixel PNG
const H2I_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/html-to-image/1.11.13/html-to-image.min.js';
const H2I_SRI = 'sha512-iZ2ORl595Wx6miw+GuadDet4WQbdSWS3JLMoNfY8cRGoEFy6oT3G9IbcrBeL6AfkgpA51ETt/faX6yLV+/gFJg==';
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const FONT_URL = 'https://fonts.gstatic.com/s/youngserif/v2/young.woff2';
const FONTS_CSS = `/* latin */\n@font-face {\n  font-family: 'Young Serif';\n  font-style: normal;\n  font-weight: 400;\n  src: url(${FONT_URL}) format('woff2');\n}\n`
  + `/* latin */\n@font-face {\n  font-family: 'Atkinson Hyperlegible Next';\n  font-weight: 700;\n  src: url(${FONT_URL}) format('woff2');\n}\n`;
/* what the page has set up at the moment it calls window.print() */
const printSnap = w => {
  const d = w.document, s = d.getElementById('print-sheet');
  return { body: d.body.className, sheet: s.className, arts: [...s.querySelectorAll('.ps-cell > .art')].map(a => a.className), page: (d.getElementById('print-page') || {}).textContent,
    title: d.title, qr: [...s.querySelectorAll('svg.qrc')].map(q => q.getAttribute('aria-label')) };
};
// the Google Fonts stylesheet and its font file, the stand-in drawer, and window.print
const withExport = (w, g, api) => {
  api.gets = []; api.printed = []; api.drawn = [];
  const post = w.fetch;
  w.fetch = (url, opts = {}) => {
    const u = String(url);
    if (String(opts.method || 'GET').toUpperCase() !== 'GET' || !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)) return post(url, opts);
    api.gets.push(u);
    if (api.fontsDown) return w.Promise.reject(new w.TypeError('Failed to fetch'));
    if (u.includes('googleapis')) return w.Promise.resolve({ ok: true, status: 200, text: async () => FONTS_CSS });
    return w.Promise.resolve({ ok: true, status: 200, blob: async () => new w.Blob([new w.Uint8Array([119, 79, 70, 50])], { type: 'font/woff2' }) });
  };
  w.print = () => { api.printed.push(printSnap(w)); };
  api.drawer = {
    toPng: async (node, opts) => {
      api.drawn.push({ node, opts, cls: node.className, staged: !!node.closest('.xstage'), width: node.style.width, height: node.style.height, uses: node.querySelectorAll('use').length,
        qr: [...node.querySelectorAll('svg.qrc')].map(q => q.getAttribute('aria-label')) });
      if (api.drawFails && (api.drawFails === 'all' || !opts.skipFonts)) throw new w.Error('tainted canvas');
      return PNG_1PX;
    },
  };
};
const withQRExport = (w, g, api) => { withQR(w, g, api); withExport(w, g, api); };
// the html-to-image script the page put in, answered as if cdnjs had sent it
function loadDrawer(p) {
  const s = p.$(`script[src="${H2I_SRC}"]`);
  assert.ok(s, 'the page asked cdnjs for html-to-image');
  p.w.htmlToImage = p.api.drawer;
  s.dispatchEvent(new p.w.Event('load'));
  return s;
}
const label = b => [...b.childNodes].filter(n => !(n.nodeType === 1 && (n.classList.contains('vh') || n.tagName.toLowerCase() === 'svg'))).map(n => n.textContent).join('').trim();

test('Flyers & posts: every piece has a Download button, the flyer, thank-you card and garden sign a Print button, and so does the event\'s strip', async t => {
  const p = await openPage(t, withQRExport, await seededSheet(t));
  await signIn(p);
  await openFlyers(p, 'w7');
  const dl = sel => p.$$(sel + ' button[data-dl]'), pr = sel => p.$$(sel + ' button[data-print]');
  assert.deepEqual(dl('#m-event').map(b => b.dataset.dl), ['flyer', 'ig', 'story', 'mail']);
  assert.deepEqual(dl('#m-any').map(b => b.dataset.dl), ['quote', 'thanks', 'sign']);
  assert.deepEqual(pr('#p-materials').map(b => b.dataset.print), ['flyer', 'thanks', 'sign'], 'the printed pieces');
  for (const b of dl('#p-materials')) {
    assert.equal(label(b), 'Download', 'the visible word');
    assert.ok(b.querySelector('svg.ic[aria-hidden="true"] use[href="#i-download"]'), 'a download icon');
    assert.equal(b.type, 'button');
    assert.ok(p.visible(b), 'shown');
  }
  for (const b of pr('#p-materials')) { assert.equal(label(b), 'Print'); assert.ok(b.querySelector('use[href="#i-printer"]'), 'a printer icon'); }
  // a screen reader hears which piece each one is for
  assert.deepEqual(dl('#p-materials').map(b => b.textContent), ['Download Flyer', 'Download Instagram post', 'Download Story', 'Download Email header', 'Download Quote post', 'Download Thank-you card', 'Download Garden sign']);
  assert.deepEqual(pr('#p-materials').map(b => b.textContent), ['Print Flyer', 'Print Thank-you card', 'Print Garden sign']);
  assert.equal(p.$('#m-event [data-dl=ig]').title, 'PNG, 1080 × 1080 pixels');
  assert.equal(p.$('#m-event [data-print=flyer]').title, 'US Letter, full page');
  // each sits under its own piece, and the event's pieces carry its id (the file name comes from it)
  for (const b of dl('#p-materials')) assert.ok(b.closest('.mat').querySelector('figure > .art'), b.textContent + ' is under its piece');
  assert.deepEqual(dl('#p-materials').map(b => b.dataset.ev), ['w7', 'w7', 'w7', 'w7', '', 'w7', '']);
  assert.ok(!p.$(`script[src*="html-to-image"]`), 'html-to-image is only loaded on the first Download');
  assert.ok(p.$('#print-sheet[aria-hidden="true"]') && !p.visible('#print-sheet'), 'the print sheet is empty and hidden on screen');
  checkIcons(p, 'Flyers & posts with Download and Print');
  // the event's own strip of pieces
  p.$('.tabs a[data-tab=events]').click();
  p.$('#tiles [data-open="w7"]').click();
  await waitFor(() => p.$('#detail .hstrip'), 2000, 'Workday #7 to open');
  assert.deepEqual(dl('#detail .hstrip').map(b => b.dataset.dl), ['flyer', 'ig', 'story', 'mail']);
  assert.deepEqual(pr('#detail .hstrip').map(b => b.dataset.print), ['flyer']);
  assert.ok(dl('#detail .hstrip').every(b => b.closest('.hfig').querySelector('figure > .art') && label(b) === 'Download'));
  checkIcons(p, 'the event strip');
  p.noErrors();
});

// jsdom does no layout, so these read the built CSS. Each button's hidden piece name (.vh) is absolutely positioned:
// without a positioned button it escapes the strip's scroll box and makes the whole pop-up or page scroll sideways at 375px.
test('Download and Print: the hidden piece name stays inside its button, and the event strip keeps each piece\'s buttons on one row', () => {
  const live = fs.readFileSync(SITE, 'utf8'), css = live.slice(live.indexOf('<style>'), live.indexOf('</style>'));
  const rule = sel => (css.match(new RegExp('\\n' + sel.replace(/[.]/g, '\\.') + ' \\{([^}]*)\\}')) || [])[1] || '';
  assert.match(css, /\n\.vh \{[^}]*position: absolute/, 'the hidden name is absolutely positioned');
  assert.match(rule('.xacts .btn'), /position: relative/, 'so each Download and Print button is its containing block');
  assert.match(rule('.hstrip'), /overflow-x: auto/, 'the strip scrolls on its own');
  assert.match(rule('.hstrip .xacts'), /flex-wrap: nowrap/, 'one row of buttons under every piece, so the captions line up');
  assert.doesNotMatch(rule('.hstrip .xacts'), /width: 0/, 'the buttons may widen a narrow piece\'s column rather than overflow it');
});

test('Download: html-to-image comes from cdnjs on the first click and draws a copy of the Instagram post at 1080 × 1080, saved as ebpg-<title>-<date>-instagram-post.png', async t => {
  const p = await openPage(t, withQRExport, await seededSheet(t));
  await signIn(p);
  const gal = await openFlyers(p, 'w7');
  const ev = p.g.tab('Events'), h = ev[0], row = ev.find(r => r[0] === 'w7');
  assert.equal(row[h.indexOf('title')], 'OPC Garden Work Party');
  const date = dateOf(p, 'w7'), art = gal.querySelector('.art.ig');
  const btn = p.$('#m-event [data-dl=ig]');
  btn.click();
  // busy while it works
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  assert.equal(label(btn), 'Preparing…');
  assert.ok(btn.querySelector('use[href="#i-loader"]'), 'a spinning loader');
  btn.click(); // a second click while busy does nothing
  const s = await waitFor(() => p.$(`script[src="${H2I_SRC}"]`), 2000, 'the html-to-image script');
  assert.equal(p.$$('script[src*="html-to-image"]').length, 1, 'asked for once');
  assert.equal(s.getAttribute('integrity'), H2I_SRI, 'pinned with its integrity hash');
  assert.equal(s.getAttribute('crossorigin'), 'anonymous');
  assert.equal(s.parentNode, p.d.head);
  loadDrawer(p);
  await waitFor(() => p.api.downloads.length === 1, 3000, 'the PNG download');
  const [d] = p.api.downloads;
  assert.equal(d.name, `ebpg-opc-garden-work-party-${date}-instagram-post.png`);
  assert.equal(date, '2026-10-25');
  assert.ok(d.blob && d.blob.type === 'image/png' && d.blob.size > 60, 'a PNG file');
  assert.equal(p.api.drawn.length, 1, 'drawn once');
  const [draw] = p.api.drawn;
  assert.equal(draw.opts.width, 1080); assert.equal(draw.opts.height, 1080); assert.equal(draw.opts.pixelRatio, 1);
  assert.equal(draw.cls, 'art ig');
  assert.ok(draw.node !== art && art.isConnected, 'a copy, so the page is left as it was');
  assert.ok(draw.staged, 'drawn off screen');
  assert.equal(draw.width, '1080px'); assert.equal(draw.height, '1080px');
  assert.equal(draw.uses, 0, 'the logo is drawn into the copy, since the image can\'t reach the icon sprite');
  assert.ok(draw.node.querySelector('.gs svg g circle'), 'the Guild mark is in the copy');
  // the Guild's fonts go into the image, each file fetched once
  assert.match(draw.opts.fontEmbedCSS, /@font-face/);
  assert.ok(draw.opts.fontEmbedCSS.includes('url(data:font/woff2;base64,d09GMg==)') && !draw.opts.fontEmbedCSS.includes(FONT_URL), 'the font files are inside');
  assert.deepEqual(p.api.gets.filter(u => u === FONT_URL).length, 1);
  await waitFor(() => !btn.hasAttribute('aria-busy'), 2000, 'the button to be ready again');
  assert.equal(label(btn), 'Download');
  assert.ok(!p.$('.xstage'), 'the copy is gone');
  assert.equal(p.$('#toast').textContent, `Downloaded ebpg-opc-garden-work-party-${date}-instagram-post.png`);
  // the flyer: US Letter at 200 dpi, with the QR code to the event's public page; the library and fonts aren't fetched again
  const gets = p.api.gets.length;
  p.$('#m-event [data-dl=flyer]').click();
  await waitFor(() => p.api.downloads.length === 2, 3000, 'the flyer');
  const fly = p.api.drawn[1];
  assert.deepEqual([fly.opts.width, fly.opts.height], [1700, 2200]);
  assert.deepEqual(fly.qr, ['QR code for ' + URL_SITE + '?ev=w7'], 'the QR code opens the event page');
  assert.equal(p.api.downloads[1].name, `ebpg-opc-garden-work-party-${date}-flyer.png`);
  assert.equal(p.$$('script[src*="html-to-image"]').length, 1);
  assert.equal(p.api.gets.length, gets, 'the fonts are fetched once');
  // the rest, at their real sizes
  const want = { story: [1080, 1920, `-${date}-story`], mail: [1200, 400, `-${date}-email-header`], quote: [1080, 1080, 'quote-post'], thanks: [2100, 1500, `-${date}-thank-you-card`], sign: [3600, 2400, 'garden-sign'] };
  for (const [k, [wd, ht, name]] of Object.entries(want)) {
    const n = p.api.downloads.length;
    await waitFor(() => !p.$(`#p-materials [data-dl=${k}]`).hasAttribute('aria-busy'), 2000, k + ' ready');
    p.$(`#p-materials [data-dl=${k}]`).click();
    await waitFor(() => p.api.downloads.length === n + 1, 3000, k);
    assert.deepEqual([p.api.drawn.at(-1).opts.width, p.api.drawn.at(-1).opts.height], [wd, ht], k + ' size');
    assert.equal(p.api.downloads.at(-1).name, name.startsWith('-') ? `ebpg-opc-garden-work-party${name}.png` : `ebpg-${name}.png`);
  }
  assert.ok(QR_IN(p.api.drawn.at(-1).qr, URL_SITE + '#join'), 'the garden sign\'s code goes to the volunteer form');
  // from the event's strip too
  p.$('.tabs a[data-tab=events]').click();
  p.$('#tiles [data-open="w7"]').click();
  await waitFor(() => p.$('#detail .hstrip [data-dl=story]'), 2000, 'Workday #7');
  const n = p.api.downloads.length;
  p.$('#detail .hstrip [data-dl=story]').click();
  await waitFor(() => p.api.downloads.length === n + 1, 3000, 'the story from the strip');
  assert.equal(p.api.downloads.at(-1).name, `ebpg-opc-garden-work-party-${date}-story.png`);
  assert.equal(p.api.drawn.at(-1).cls, 'art story');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});
const QR_IN = (labels, link) => labels.includes('QR code for ' + link);

test("Download: when the image can't be made the button comes back and says to Print instead; without the fonts the image still comes", async t => {
  const p = await openPage(t, withQRExport, await seededSheet(t));
  await signIn(p);
  await openFlyers(p, 'w7');
  p.w.htmlToImage = p.api.drawer; // already loaded
  p.api.drawFails = 'all';
  const btn = p.$('#m-event [data-dl=flyer]');
  btn.click();
  await waitFor(() => !btn.hasAttribute('aria-busy'), 3000, 'the button to come back');
  assert.equal(p.$('#toast').textContent, "Couldn't make the image. Try Print instead.");
  assert.ok(p.$('#toast use[href="#i-alert-triangle"]'));
  assert.equal(label(btn), 'Download');
  assert.deepEqual(p.api.drawn.map(d => !!d.opts.skipFonts), [false, true], 'tried again without the fonts');
  assert.equal(p.api.downloads.length, 0);
  assert.ok(!p.$('.xstage'), 'the copy is gone');
  // the Instagram post has no Print
  p.$('#m-event [data-dl=ig]').click();
  await waitFor(() => p.api.drawn.length === 4, 3000, 'the second try');
  await waitFor(() => /Check your connection/.test(p.$('#toast').textContent), 2000, 'the toast');
  assert.equal(p.$('#toast').textContent, "Couldn't make the image. Check your connection and try again.");
  // drawing with the fonts fails, without them it works
  p.api.drawFails = 'fonts';
  p.$('#m-event [data-dl=story]').click();
  await waitFor(() => p.api.downloads.length === 1, 3000, 'the story, without the fonts');
  // the fonts can't be fetched at all: the image comes in the browser's own
  p.api.drawFails = '';
  const q = await openPage(t, withQRExport, p.g);
  await signIn(q);
  await openFlyers(q, 'w7');
  q.w.htmlToImage = q.api.drawer;
  q.api.fontsDown = true;
  q.$('#m-event [data-dl=mail]').click();
  await waitFor(() => q.api.downloads.length === 1, 3000, 'the email header');
  assert.equal(q.api.drawn[0].opts.fontEmbedCSS, '', 'no fonts to put in');
  q.$('#m-event [data-dl=mail]').click();
  await waitFor(() => q.api.downloads.length === 2, 3000, 'the email header again');
  assert.equal(q.api.gets.filter(u => u.includes('googleapis')).length, 2, 'the fonts are tried again next time');
  // html-to-image doesn't load (offline, or cdnjs blocked)
  const r = await openPage(t, withQRExport, p.g);
  await signIn(r);
  await openFlyers(r, 'w7');
  const rb = r.$('#m-any [data-dl=sign]');
  rb.click();
  const s = await waitFor(() => r.$(`script[src="${H2I_SRC}"]`), 2000, 'the script');
  s.dispatchEvent(new r.w.Event('error'));
  await waitFor(() => !rb.hasAttribute('aria-busy'), 2000, 'the button to come back');
  assert.equal(r.$('#toast').textContent, "Couldn't make the image. Try Print instead.");
  assert.ok(!r.$(`script[src="${H2I_SRC}"]`), 'the failed script is taken out, so the next click asks again');
  rb.click();
  await waitFor(() => r.$(`script[src="${H2I_SRC}"]`), 2000, 'a new try');
  loadDrawer(r);
  await waitFor(() => r.api.downloads.length === 1, 3000, 'the sign');
  for (const x of [p, q, r]) { await waitFor(x.idle, 2000, 'calls to finish'); assert.deepEqual(x.api.errors, [], 'no script errors'); }
});

test('Print: the flyer alone on a US Letter page with its QR code, two thank-you cards with cut lines, the sign sideways; everything goes back after printing', async t => {
  const sheet = await seededSheet(t);
  // a title with accents and punctuation still makes a plain file name
  const ev = sheet.tab('Events'), h = ev[0];
  sheet.sheets.get('Events').set(ev.findIndex(r => r[0] === 'w7') + 1, h.indexOf('title') + 1, 'Café & Compost: Día 2!');
  const p = await openPage(t, withQRExport, sheet);
  await signIn(p);
  await openFlyers(p, 'w7');
  const date = dateOf(p, 'w7'), title = p.d.title;
  const css = fs.readFileSync(SITE, 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /@media print \{[\s\S]*body\.printing > :not\(#print-sheet\) \{ display: none !important; \}/, 'only the print sheet prints');
  assert.match(css, /#print-sheet \* \{ -webkit-print-color-adjust: exact; print-color-adjust: exact; \}/, 'with its colors');
  p.$('#m-event [data-print=flyer]').click();
  assert.equal(p.api.printed.length, 1, 'window.print() was called');
  assert.deepEqual(p.api.printed[0], { body: 'printing', sheet: 'ps-letter', arts: ['art flyer'], page: '@page { size: letter portrait; margin: 0.4in; }',
    title: `ebpg-cafe-compost-dia-2-${date}-flyer`, qr: ['QR code for ' + URL_SITE + '?ev=w7'] });
  // the copy stays until the browser says it has printed
  assert.ok(p.$('#print-sheet .ps-cell > .art.flyer .qr svg.qrc'), 'a copy of the flyer is in #print-sheet');
  assert.ok(p.$('#m-event .art.flyer'), 'and the flyer is still on the page');
  p.w.dispatchEvent(new p.w.Event('afterprint'));
  assert.equal(p.$('#print-sheet').children.length, 0, 'the print sheet is emptied');
  assert.ok(!p.d.body.classList.contains('printing') && !p.$('#print-page'), 'the page and its size go back');
  assert.equal(p.d.title, title, 'the tab title goes back');
  // two thank-you cards to a page
  p.$('#m-any [data-print=thanks]').click();
  assert.deepEqual(p.api.printed[1], { body: 'printing', sheet: 'ps-cards', arts: ['art card5', 'art card5'], page: '@page { size: letter portrait; margin: 0.4in; }',
    title: `ebpg-cafe-compost-dia-2-${date}-thank-you-card`, qr: [] });
  assert.match(css, /#print-sheet\.ps-cards \.ps-cell \{[^}]*border: 1px dashed/, 'with cut lines');
  // a browser that doesn't say when it has printed: the next key press puts things back
  await sleep(10);
  p.w.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab' }));
  assert.equal(p.$('#print-sheet').children.length, 0);
  assert.equal(p.d.title, title);
  // the garden sign, sideways
  p.$('#m-any [data-print=sign]').click();
  assert.deepEqual(p.api.printed[2], { body: 'printing', sheet: 'ps-landscape', arts: ['art sign'], page: '@page { size: letter landscape; margin: 0.4in; }',
    title: 'ebpg-garden-sign', qr: ['QR code for ' + URL_SITE + '#join'] });
  // Print again before the last one finished: the old copy goes first
  p.$('#m-event [data-print=flyer]').click();
  assert.deepEqual(p.api.printed[3].arts, ['art flyer']);
  assert.equal(p.$$('#print-page').length, 1, 'one page size');
  p.w.dispatchEvent(new p.w.Event('afterprint'));
  assert.equal(p.d.title, title);
  // from the event's strip
  p.$('.tabs a[data-tab=events]').click();
  p.$('#tiles [data-open="w7"]').click();
  await waitFor(() => p.$('#detail .hstrip [data-print=flyer]'), 2000, 'Workday #7');
  const before = p.d.title;
  p.$('#detail .hstrip [data-print=flyer]').click();
  assert.deepEqual(p.api.printed[4].arts, ['art flyer']);
  assert.deepEqual(p.api.printed[4].qr, ['QR code for ' + URL_SITE + '?ev=w7']);
  p.w.dispatchEvent(new p.w.Event('afterprint'));
  assert.equal(p.d.title, before);
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
test('the prototype artifact downloads and prints its pieces too, with codes to the public site; on an iPhone the image is drawn twice', async t => {
  const p = loadPage(t, ARTIFACT, 'http://localhost/artifact', (w, g, api) => { withQRExport(w, g, api); Object.defineProperty(w.navigator, 'userAgent', { configurable: true, get: () => IPHONE }); });
  await waitFor(() => p.shown('#p-landing'), 2000, 'the artifact landing page');
  p.$('#signin-top').click();
  p.$('#si-google').click();
  await openFlyers(p, 'w7');
  assert.deepEqual(p.$$('#p-materials [data-dl]').length, 7);
  p.$('#m-event [data-print=flyer]').click();
  assert.deepEqual(p.api.printed[0].qr, ['QR code for https://ebpg-event-hub.netlify.app/?ev=w7']);
  p.w.dispatchEvent(new p.w.Event('afterprint'));
  p.$('#m-event [data-dl=ig]').click();
  await waitFor(() => p.$(`script[src="${H2I_SRC}"]`), 2000, 'the script');
  loadDrawer(p);
  await waitFor(() => p.api.downloads.length === 1, 3000, 'the Instagram post');
  assert.deepEqual([p.api.drawn[0].opts.width, p.api.drawn[0].opts.height], [1080, 1080]);
  assert.equal(p.api.drawn.length, 2, 'Safari puts the fonts and photos in only on the second try, so it draws twice and keeps the second');
  assert.match(p.api.downloads[0].name, /^ebpg-opc-garden-work-party-\d{4}-\d{2}-\d{2}-instagram-post\.png$/);
  assert.deepEqual(p.api.calls, [], 'the artifact calls no server');
  p.noErrors();
});

/* ---------- the Channels tab, and drafts that link to the event's own page ---------- */
const NO_LINK = 'Add the link on the Channels tab';
const W7_LINK = 'Details, directions and sign-up: ' + URL_SITE + '?ev=w7';
const chCell = (g, id, head, v) => { const tab = g.tab('Channels'); g.sheets.get('Channels').set(tab.findIndex(r => r[0] === id) + 1, tab[0].indexOf(head) + 1, v); };
const shownChannels = p => p.$$('#dp-out .orow').map(r => r.dataset.row);
const alsoPostTo = p => p.$$('#add-ch option').map(o => o.value).filter(Boolean);
const postText = (p, id, ch) => (p.g.tab('Posts').find(r => r[0] === id && r[1] === ch) || [])[4];
// coming back to the tab: the page reads the Sheet again (a few ms on, so a save that just finished counts as older)
async function readAgain(p) {
  const reads = () => p.api.done.filter(c => c.fn === 'signIn').length, before = reads();
  await sleep(5);
  p.d.dispatchEvent(new p.w.Event('visibilitychange'));
  await waitFor(() => reads() === before + 1 && p.idle(), 3000, 'the Sheet to be read again');
}
// a new event, saved: its id and the channels it has Posts rows for
async function newEventChannels(p, title) {
  p.$('#new-ev').click();
  await waitFor(() => p.$('#editf #ed-title'), 2000, 'the new event form');
  p.set('#ed-title', title);
  p.$('#editf button[type=submit]').click();
  const id = await waitFor(() => (p.g.tab('Events').find(r => r[2] === title) || [])[0], 3000, 'the new event in the Sheet');
  await waitFor(() => p.g.tab('Posts').some(r => r[0] === id) && p.idle(), 3000, 'its Posts rows');
  p.$('#m-x').click();
  return p.g.tab('Posts').filter(r => r[0] === id).map(r => r[1]).sort();
}

test("the Channels tab: Luma and Meetup stay out of sight, new events start with the ones marked for them, and Open goes to the tab's link", async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  assert.deepEqual(p.g.tab('Channels').map(r => r[0]), ['channel', 'partiful', 'ggroup', 'calendar', 'facebook', 'instagram', 'chats', 'luma', 'meetup'], 'the tab and its 8 rows');
  const out = await outreach(p, 'w7');
  assert.deepEqual(shownChannels(p), ['partiful', 'ggroup', 'calendar', 'instagram', 'chats']);
  assert.deepEqual(alsoPostTo(p), ['facebook'], 'Also post to has only channels the Guild uses');
  assert.ok(!/Luma|Meetup/.test(out.textContent), 'no Luma or Meetup anywhere');

  // the drafts link to the event's own page, not the Linktree; Partiful is the RSVP, so its post has no link
  p.$('#dp-out [data-row=ggroup] [data-act=toggle]').click();
  const group = p.$('#ta-w7-ggroup').value;
  assert.ok(group.includes('?ev=w7') && group.includes(W7_LINK + '\n\nSee you there,'), group);
  assert.ok(!/Linktree|RSVP on/.test(group), 'no Linktree, and no RSVP line before there is an RSVP link');
  assert.ok(postText(p, 'w7', 'ggroup').includes(W7_LINK), 'the starter drafts in the Sheet have it too');
  assert.ok(postText(p, 'w7', 'calendar').endsWith(W7_LINK), 'the Calendar description ends with it');
  assert.ok(postText(p, 'w7', 'chats').endsWith("Who's in?\n" + W7_LINK));
  assert.ok(!/https?:/.test(postText(p, 'w7', 'partiful')), 'the Partiful post has no link');
  assert.match(postText(p, 'w7', 'instagram'), /\nRSVP: link in bio\.\n/);
  assert.ok(!JSON.stringify(p.g.tab('Posts')).includes('Linktree'), 'no draft sends people to the Linktree');

  // Open <name> uses the tab's link; with none yet, a hint says where to add it (a link to the Sheet)
  p.$('#dp-out [data-act=approve][data-ch=partiful]').click();
  assert.equal(p.$('#dp-out [data-row=partiful] .oacts a').href, 'https://partiful.com/');
  p.$('#dp-out [data-act=approve][data-ch=instagram]').click();
  assert.deepEqual(acts(p, 'instagram'), ['Download image', 'Copy caption', 'Mark as posted', NO_LINK]);
  const hint = p.$('#dp-out [data-row=instagram] .oacts a.nolink');
  assert.deepEqual([hint.href, hint.target, hint.rel], ['https://docs.google.com/spreadsheets/d/sheet-1/edit', '_blank', 'noopener']);
  assert.ok(!p.$('#dp-out [data-row=instagram] a[href*="instagram.com"]'), 'not a generic home page');
  p.$('#dp-out [data-row=chats] [data-act=toggle]').click();
  assert.equal(p.$('#dp-out [data-row=chats] .obody .nolink').textContent, NO_LINK, 'a draft being read says it too');
  checkIcons(p, 'channels without a link');
  p.$('#m-x').click();
  await waitFor(p.idle, 2000, 'saves to finish');

  // a new event starts with the channels marked "on for new events"
  assert.deepEqual(await newEventChannels(p, 'Seed Swap'), ['calendar', 'chats', 'facebook', 'ggroup', 'instagram', 'partiful']);

  // a volunteer changes the tab by hand: Luma on (and for new events), Instagram off, the Facebook group's link, a row the app doesn't know
  const g = p.g;
  chCell(g, 'luma', 'used', 'TRUE'); chCell(g, 'luma', 'on for new events', 'TRUE'); chCell(g, 'luma', 'link', 'https://lu.ma/ebpg');
  chCell(g, 'instagram', 'used', 'FALSE');
  chCell(g, 'facebook', 'link', 'https://www.facebook.com/groups/eastbaypermaculture');
  ['myspace', 'MySpace', 'TRUE', 'https://myspace.com/', 'TRUE', 'copy and paste'].forEach((v, j) => g.sheets.get('Channels').set(10, j + 1, v));
  p.$('#signout').click();
  await signIn(p, 'Jessie');
  await outreach(p, 'w7');
  assert.deepEqual(shownChannels(p), ['partiful', 'ggroup', 'calendar', 'chats'], "Instagram's approved draft is out of sight");
  assert.ok(g.tab('Posts').some(r => r[0] === 'w7' && r[1] === 'instagram' && r[2] === 'approved'), 'and kept in the Sheet');
  assert.deepEqual(alsoPostTo(p), ['luma', 'facebook']);
  assert.ok(!/MySpace/i.test(p.$('#dp-out').innerHTML), 'unknown ids are ignored');
  assert.match(p.$('#dp-out .osum').textContent, /^\d drafts to review · 1 approved, ready to post/, 'the hidden one is not counted');
  p.set('#add-ch', 'facebook');
  assert.match(p.$('#ta-w7-facebook').value, /New faces very welcome!\n\nDetails, directions and sign-up: http:\/\/localhost:8766\/site\?ev=w7$/);
  p.$('#dp-out [data-act=approve][data-ch=facebook]').click();
  assert.deepEqual(acts(p, 'facebook'), ['Copy text', 'Open Facebook group', 'Mark as posted']);
  assert.equal(p.$('#dp-out [data-row=facebook] .oacts a').href, 'https://www.facebook.com/groups/eastbaypermaculture');
  p.$('#m-x').click();
  await waitFor(p.idle, 2000, 'saves to finish');
  assert.deepEqual(await newEventChannels(p, 'Cob Oven Day'), ['calendar', 'chats', 'facebook', 'ggroup', 'luma', 'partiful']);
  // Luma turned off again: gone from sight everywhere
  chCell(g, 'luma', 'used', 'FALSE');
  p.$('#signout').click();
  await signIn(p, 'Jessie');
  const id = g.tab('Events').find(r => r[2] === 'Cob Oven Day')[0];
  await outreach(p, id);
  assert.ok(!shownChannels(p).includes('luma') && !alsoPostTo(p).includes('luma'));
  assert.ok(!/Luma/.test(drawn(p)), 'Luma no longer appears anywhere on the page');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test("Partiful marked posted with its link: Yes makes it the event's RSVP link, the drafts link to it, and the public page says Also on Partiful", async t => {
  const p = await openPage(t);
  await signIn(p, 'Phil');
  await outreach(p, 'w7');
  p.$('#appr-all').click();
  await waitFor(p.idle, 2000, 'saves to finish');
  p.$('#dp-out [data-act=mark][data-ch=partiful]').click();
  p.set('#mk-w7-partiful', 'https://partiful.com/e/w7dig');
  p.$('form[data-mark=partiful] button[type=submit]').click();
  const ASK = "Use this as the event's RSVP link?https://partiful.com/e/w7dig";
  assert.equal(p.$('#dp-out [data-row=partiful] .oask p').textContent, ASK);
  // read first, answered later: the question stays once the Sheet has the post, and through a read of the Sheet
  // that brings in someone else's change to the event
  await waitFor(() => postRow(p, 'w7', 'partiful')?.status === 'posted' && p.idle(), 3000, 'the post to be saved');
  setEvCell(p.g, 'w7', 'notes', 'Bring the long hose');
  await readAgain(p);
  assert.match(p.$('#detail').textContent, /Bring the long hose/, "the Sheet's change is in");
  assert.equal(p.$('#dp-out [data-row=partiful] .oask p')?.textContent, ASK, 'the question is still there');
  assert.deepEqual(p.$$('#dp-out .oask button').map(b => b.textContent), ['Yes', 'No']);
  checkIcons(p, 'the RSVP question');
  p.$('#dp-out [data-act=rsvp-yes][data-ch=partiful]').click();
  assert.ok(!p.$('#dp-out .oask'), 'the question goes');
  assert.equal(p.d.activeElement.dataset.act, 'undo', 'focus moves to Undo');
  // the approved posts that mention it go back to review with the RSVP line; Instagram (link in bio) stays approved
  assert.deepEqual(['ggroup', 'calendar', 'chats', 'instagram'].map(ch => pill(p, ch)), ['Draft · needs review', 'Draft · needs review', 'Draft · needs review', 'Approved by Phil']);
  await waitFor(() => p.api.toasts.includes('RSVP link saved. 3 approved posts link to it now, so they need review again.'), 3000, 'the toast');
  assert.equal(evCell(p, 'w7', 'rsvp link'), 'https://partiful.com/e/w7dig');
  assert.ok(postText(p, 'w7', 'ggroup').includes(W7_LINK + '\nRSVP on Partiful: https://partiful.com/e/w7dig\n\nSee you there,'), postText(p, 'w7', 'ggroup'));
  assert.ok(postText(p, 'w7', 'calendar').endsWith('RSVP on Partiful: https://partiful.com/e/w7dig'));
  assert.ok(!postText(p, 'w7', 'partiful').includes('https'), 'the Partiful post itself has no link');
  assert.equal(activity(p, 'w7').at(-1), 'Phil set the RSVP link to the Partiful post');
  // a visitor's event page
  p.$('#m-x').click();
  await waitFor(p.idle, 2000, 'saves to finish');
  const q = await eventPage(t, 'w7', null, p.g);
  assert.equal(q.$('#pe-rsvp').textContent, 'Also on Partiful');
  assert.equal(q.$('#pe-rsvp').getAttribute('href'), 'https://partiful.com/e/w7dig');
  p.noErrors(); q.noErrors();
});

test("the RSVP question: only when the event has no RSVP link yet, only with a link, and only for someone who can edit events", async t => {
  // Sky can approve and post, but not edit events
  const p = await openPage(t);
  await signIn(p, 'Sky');
  await outreach(p, 'w7');
  p.$('#dp-out [data-act=approve][data-ch=partiful]').click();
  p.$('#dp-out [data-act=mark][data-ch=partiful]').click();
  p.set('#mk-w7-partiful', 'https://partiful.com/e/w7dig');
  p.$('form[data-mark=partiful] button[type=submit]').click();
  assert.ok(!p.$('#dp-out .oask'), 'no question for Sky');
  assert.equal(p.d.activeElement.dataset.act, 'undo');
  await waitFor(p.idle, 2000, 'saves to finish');
  // no link given, or an RSVP link already set: no question
  const q = await openPage(t);
  await signIn(q, 'Jessie');
  await outreach(q, 'w7');
  q.$('#dp-out [data-act=approve][data-ch=partiful]').click();
  q.$('#dp-out [data-act=mark][data-ch=partiful]').click();
  q.$('form[data-mark=partiful] button[type=submit]').click();
  assert.ok(!q.$('#dp-out .oask'), 'no link, no question');
  q.$('#dp-out [data-act=undo][data-ch=partiful]').click();
  await waitFor(() => postRow(q, 'w7', 'partiful')?.status === 'approved' && q.idle(), 3000, 'the undo to be saved');
  setEvCell(q.g, 'w7', 'rsvp link', 'https://partiful.com/e/already');
  q.$('#signout').click();
  await signIn(q, 'Jessie');
  await outreach(q, 'w7');
  q.$('#dp-out [data-act=mark][data-ch=partiful]').click();
  q.set('#mk-w7-partiful', 'https://partiful.com/e/w7dig');
  q.$('form[data-mark=partiful] button[type=submit]').click();
  assert.ok(!q.$('#dp-out .oask'), 'the event has an RSVP link already');
  q.$('#dp-out [data-row=ggroup] [data-act=toggle]').click();
  assert.match(q.$('#ta-w7-ggroup').value, /\nRSVP on Partiful: https:\/\/partiful\.com\/e\/already\n/, 'a draft nobody edited has the RSVP link typed into the Sheet');
  await waitFor(q.idle, 2000, 'saves to finish');
  p.noErrors(); q.noErrors();
});

test("a draft event's posts don't link to its page until Publish; then the drafts nobody edited do, and approved ones need review again", async t => {
  const p = await openPage(t);
  await signIn(p, 'Phil');
  const m2Posts = () => p.g.tab('Posts').filter(r => r[0] === 'm2');
  assert.deepEqual(m2Posts().map(r => r[1]), ['partiful', 'ggroup', 'calendar', 'instagram', 'chats']);
  assert.ok(m2Posts().every(r => !r[4].includes('?ev=')), "no starter draft links to a page that isn't there yet");
  // an earlier version of the page did put the link in a draft event's posts: the page takes it out again
  const link = 'Details, directions and sign-up: ' + URL_SITE + '?ev=m2', cal = postText(p, 'm2', 'calendar');
  p.g.sheets.get('Posts').set(p.g.tab('Posts').findIndex(r => r[0] === 'm2' && r[1] === 'calendar') + 1, p.g.tab('Posts')[0].indexOf('text') + 1, cal + '\n\n' + link);
  p.$('#signout').click();
  await signIn(p, 'Phil');
  await outreach(p, 'm2');
  p.$('#dp-out [data-row=calendar] [data-act=toggle]').click();
  assert.equal(p.$('#ta-m2-calendar').value, cal, 'not counted as a hand edit');
  p.$('#dp-out [data-row=ggroup] [data-act=toggle]').click();
  const group = p.$('#ta-m2-ggroup').value;
  assert.ok(!group.includes('?ev=') && /\nWhere: [^\n]+\nBring: [^\n]+\n\n[^\n]+\n\nSee you there,/.test(group), group);
  // Phil approves the Group email (it could be posted now, with no link to a missing page), and adds a line to the chats by hand
  p.$('#dp-out [data-act=approve][data-ch=ggroup]').click();
  assert.deepEqual(acts(p, 'ggroup'), ['Post']);
  p.$('#dp-out [data-row=chats] [data-act=toggle]').click();
  const mine = p.$('#ta-m2-chats').value + ' Bring a friend!';
  p.set('#ta-m2-chats', mine);
  await waitFor(() => postRow(p, 'm2', 'ggroup')?.status === 'approved' && postText(p, 'm2', 'chats') === mine && p.idle(), 3000, 'the approval and the edit to be saved');
  p.$('#detail #publish-ev').click();
  await waitFor(() => p.api.toasts.includes("Published. It's on the public site now. 1 approved post changed, so it needs review again."), 3000, 'the toast');
  assert.equal(pill(p, 'ggroup'), 'Draft · needs review', 'the approved Group email goes back to review');
  assert.equal(p.$('#ta-m2-ggroup').value, group.replace('\n\nSee you there,', '\n\n' + link + '\n\nSee you there,'), 'with the link added');
  assert.equal(postRow(p, 'm2', 'ggroup').status, 'review');
  assert.equal(postText(p, 'm2', 'ggroup'), p.$('#ta-m2-ggroup').value, 'and so does the Sheet');
  assert.ok(postText(p, 'm2', 'calendar').endsWith(link), 'the Calendar draft has it too');
  assert.equal(postText(p, 'm2', 'chats'), mine, 'a draft changed by hand keeps its text');
  assert.ok(!postText(p, 'm2', 'partiful').includes('https'), 'the Partiful post still has no link');
  // the link works: a visitor gets the event's page
  p.$('#m-x').click();
  await waitFor(p.idle, 2000, 'saves to finish');
  const q = await eventPage(t, 'm2', null, p.g);
  assert.ok(!q.$('.pe-gone'), "not \"This event isn't on the calendar anymore\"");
  assert.equal(q.$('#pe-title').textContent, 'OPC Community Meeting');
  p.noErrors(); q.noErrors();
});

test('a draft fixed by hand in the Posts tab keeps its text after signing in again, through a read of the Sheet and after Approve', async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  const g = p.g, posts = g.sheets.get('Posts'), TEXT = g.tab('Posts')[0].indexOf('text') + 1;
  const at = ch => g.tab('Posts').findIndex(r => r[0] === 'w7' && r[1] === ch) + 1;
  // a typo fixed in the Group email's text, and a new start time typed into the Events tab
  const fixed = postText(p, 'w7', 'ggroup').replace('See you there,', 'See you in the garden,');
  posts.set(at('ggroup'), TEXT, fixed);
  setEvCell(g, 'w7', 'start', '09:30');
  p.$('#signout').click();
  await signIn(p, 'Jessie');
  await outreach(p, 'w7');
  p.$('#dp-out [data-row=ggroup] [data-act=toggle]').click();
  assert.equal(p.$('#ta-w7-ggroup').value, fixed, 'the page shows the fix');
  p.$('#dp-out [data-row=chats] [data-act=toggle]').click();
  assert.match(p.$('#ta-w7-chats').value, /^OPC Garden Work Party is Sun 10\/25 at 9:30am, Oakland Peace Center\./, 'a draft nobody touched has the new time');
  p.$('#dp-out [data-act=approve][data-ch=ggroup]').click();
  await waitFor(() => postRow(p, 'w7', 'ggroup')?.status === 'approved' && p.idle(), 3000, 'the approval to be saved');
  assert.equal(postText(p, 'w7', 'ggroup'), fixed, 'the Sheet keeps the fix');
  assert.ok(postRow(p, 'w7', 'ggroup').edited, 'and says it was edited');
  assert.match(postText(p, 'w7', 'chats'), /at 9:30am/, 'the untouched draft is saved with the new time');
  assert.ok(!postRow(p, 'w7', 'chats').edited);
  // a line added to the chats message in the Sheet while the page is open comes in with the next read, and stays
  const fix2 = postText(p, 'w7', 'chats') + '\nCarpool from Fruitvale BART at 9.';
  posts.set(at('chats'), TEXT, fix2);
  await readAgain(p);
  assert.equal(p.$('#ta-w7-chats').value, fix2);
  // changing the event doesn't write over either fix
  (await waitFor(() => p.$('#detail #edit-ev'), 2000, 'the event')).click();
  await waitFor(() => p.$('#editf'), 2000, 'the edit form');
  p.set('#ed-end', '13:30');
  p.$('#editf button[type=submit]').click();
  await waitFor(() => p.api.toasts.includes('Saved') && p.idle(), 3000, 'the save');
  assert.equal(postText(p, 'w7', 'ggroup'), fixed);
  assert.equal(postText(p, 'w7', 'chats'), fix2);
  assert.ok(postText(p, 'w7', 'calendar').length && !postRow(p, 'w7', 'calendar').edited, 'the others are still the app\'s own');
  // clearing the text and edited cells has the app write the draft again
  assert.ok(postRow(p, 'w7', 'chats').edited, 'the chats fix counts as edited now');
  posts.set(at('chats'), TEXT, '');
  posts.set(at('chats'), TEXT + 1, '');
  p.$('#m-x').click();
  p.$('#signout').click();
  await signIn(p, 'Jessie');
  await outreach(p, 'w7');
  p.$('#dp-out [data-row=chats] [data-act=toggle]').click();
  assert.match(p.$('#ta-w7-chats').value, /^OPC Garden Work Party is Sun 10\/25 at 9:30am, [^\n]+ Who's in\?\n/);
  assert.ok(!p.$('#ta-w7-chats').value.includes('Carpool'));
  p.noErrors();
});

/* ---------- the Posting Helper (chrome-extension/): Open & fill, and how to get it ---------- */
// The extension's real content script for the Event Hub (src/hub-bridge.js) runs on the page, with a stand-in for Chrome's
// storage and service worker, so the page's message has to pass the helper's own checks. jsdom's postMessage gives no
// source or origin, so it is replaced with one that does what a browser does.
const { createHubBridge } = require('../../chrome-extension/src/hub-bridge.js');
const ZIP_SITE = path.join(__dirname, '..', 'site', 'ebpg-posting-helper.zip');
const ZIP_EXT = path.join(__dirname, '..', '..', 'chrome-extension', 'dist', 'ebpg-posting-helper.zip');
const OPENED = site => `Opened ${site}. Review the form and publish there, then come back and mark it posted.`;
function browserPostMessage(w, api) {
  w.postMessage = (data, target) => {
    const origin = w.location.origin;
    if (target !== '*' && target !== origin) return;
    const copy = w.JSON.parse(w.JSON.stringify(data));
    w.setTimeout(() => w.dispatchEvent(new w.MessageEvent('message', { data: copy, origin, source: w })), 0);
  };
  api.messages = []; api.times = [];
  w.addEventListener('message', e => { api.messages.push(e.data); api.times.push(Date.now()); });
}
const withHelper = (w, g, api) => {
  withQRExport(w, g, api);
  browserPostMessage(w, api);
  api.saved = []; api.opens = []; api.answer = { ok: true };
  createHubBridge({
    win: w, doc: w.document, version: '1.0.0',
    runtime: { id: 'ebpg-helper', sendMessage: async m => { api.opens.push(m); return api.answer; } },
    storage: { set: async o => { api.saved.push(o); } },
  }).start();
};
const hubAsks = p => p.api.messages.filter(m => m && m.source === 'ebpg-hub');
// when the page's nth message to the helper (from 0) went out
const sentAt = (p, n) => p.api.times.filter((_, i) => p.api.messages[i] && p.api.messages[i].source === 'ebpg-hub')[n];
const kinds = (p, ch) => p.$$(`#dp-out [data-row="${ch}"] .oacts > .btn`).map(b => b.classList.contains('primary') ? 'primary' : 'ghost');
const fillNoteOf = (p, ch) => p.$(`#dp-out [data-row="${ch}"] .ofill`);

test('with the Posting Helper: Open & fill hands it the event, the flyer and the approved text, and the row says to review and mark it posted', async t => {
  const p = await openPage(t, withHelper);
  assert.equal(p.d.documentElement.dataset.ebpgPoster, '1.0.0', 'the helper marked the page');
  await signIn(p, 'Phil');
  await outreach(p, 'w7');
  assert.ok(!p.$('#helper-tog'), 'no "get the helper" link once it is installed');
  assert.ok(!p.$('#dp-out [data-act=fill]'), 'nothing to fill before approval');
  p.$('#dp-out [data-act=approve][data-ch=partiful]').click();
  assert.deepEqual(acts(p, 'partiful'), ['Open & fill', 'Copy text', 'Mark as posted'], 'Open & fill is the main action; the helper opens the site itself');
  assert.deepEqual(kinds(p, 'partiful'), ['primary', 'ghost', 'ghost'], 'drawn as the main action, with Mark as posted beside it');
  const fill = p.$('#dp-out [data-act=fill][data-ch=partiful]');
  assert.ok(fill.querySelector('svg.ic[aria-hidden="true"] use[href="#i-wand"]'), 'with an icon');
  assert.equal(p.d.activeElement, fill, 'focus moves to Open & fill');
  assert.equal(p.$('#dp-out [data-row=partiful] .oname .hint').textContent, 'Read draft · the Posting Helper fills it in');
  assert.equal(p.$('#dp-out [data-row=instagram] .oname .hint').textContent, 'Read draft · copy and paste');
  checkIcons(p, 'Open & fill');

  // the flyer is drawn for it; the helper gets the event and Partiful's own text
  p.w.htmlToImage = p.api.drawer;
  const text = postText(p, 'w7', 'partiful');
  fill.click();
  assert.equal(fill.getAttribute('aria-busy'), 'true');
  assert.equal(label(fill), 'Preparing…');
  await waitFor(() => hubAsks(p).length === 1, 3000, 'the message to the helper');
  const [ask] = hubAsks(p);
  assert.deepEqual(Object.keys(ask), ['source', 'type', 'channel', 'draft']);
  assert.deepEqual([ask.type, ask.channel], ['fill', 'partiful']);
  const d = ask.draft;
  assert.deepEqual(Object.keys(d), ['title', 'date', 'start', 'end', 'place', 'address', 'description', 'text', 'eventUrl', 'imageDataUrl']);
  assert.equal(d.title, 'OPC Garden Work Party');
  assert.equal(d.date, dateOf(p, 'w7'));
  assert.match(d.start, /^\d\d:\d\d$/); assert.match(d.end, /^\d\d:\d\d$/);
  assert.deepEqual([d.place, d.address], [evCell(p, 'w7', 'place'), evCell(p, 'w7', 'address')]);
  assert.equal(d.description, text, 'the description is the channel draft');
  assert.equal(d.text, text);
  assert.equal(d.eventUrl, URL_SITE + '?ev=w7', "the event's public page");
  assert.equal(d.imageDataUrl, PNG_1PX, 'the flyer, as a PNG');
  const fly = p.api.drawn.at(-1);
  assert.equal(fly.cls, 'art flyer');
  assert.deepEqual([fly.opts.width, fly.opts.height], [1020, 1320], 'Letter-shaped, smaller than the printed one');
  assert.ok(fly.staged && !p.$('.xstage'), 'drawn off screen, and the copy is gone');
  // the helper's own checks let it through: it saved the event and opened Partiful
  await waitFor(() => p.api.opens.length === 1, 2000, 'the helper to open the site');
  assert.deepEqual(p.api.opens[0], { type: 'open', channel: 'partiful' });
  assert.equal(p.api.saved[0].draft.channel, 'partiful');
  assert.equal(p.api.saved[0].draft.origin, 'http://localhost:8766');
  assert.equal(p.api.saved[0].draft.draft.title, 'OPC Garden Work Party');
  assert.equal(p.api.saved[0].draft.draft.imageDataUrl, PNG_1PX);
  await waitFor(() => p.api.toasts.includes(OPENED('Partiful')), 2000, 'the opened toast');
  assert.ok(p.api.messages.some(m => m.source === 'ebpg-poster' && m.type === 'opened' && m.channel === 'partiful'), "the helper's answer");
  assert.equal(fillNoteOf(p, 'partiful').textContent, OPENED('Partiful'), 'it stays under the row');
  assert.ok(p.$('#dp-out [data-row=partiful]').classList.contains('approved'), 'opening is not posting');
  assert.equal(label(p.$('#dp-out [data-act=fill][data-ch=partiful]')), 'Open & fill', 'ready again');
  assert.equal(p.d.activeElement.dataset.act, 'fill');
  assert.deepEqual(kinds(p, 'partiful'), ['ghost', 'ghost', 'primary'], 'once it opened the site, Mark as posted is the next step');
  // the approve / mark-as-posted trail is still the record
  p.$('#dp-out [data-act=mark][data-ch=partiful]').click();
  p.$('form[data-mark=partiful] button[type=submit]').click();
  assert.match(pill(p, 'partiful'), /^Posted by Phil/);
  assert.ok(!fillNoteOf(p, 'partiful'), 'the note goes once it is posted');
  await waitFor(() => postRow(p, 'w7', 'partiful')?.status === 'posted', 3000, 'the Posts row');
  await waitFor(p.idle, 2000, 'saves to finish');
  assert.deepEqual(activity(p, 'w7').slice(-3), ['Phil approved Partiful', 'Phil opened Partiful with the Posting Helper', 'Phil marked Partiful as posted']);

  // the chats fill Hylo, and share to WhatsApp; a flyer that can't be drawn is left out, and the rest still goes
  p.$('#dp-out [data-act=approve][data-ch=chats]').click();
  assert.deepEqual(acts(p, 'chats'), ['Open Hylo & fill', 'Copy text', 'Share to WhatsApp', 'Mark as posted']);
  const chats = postText(p, 'w7', 'chats');
  const wa = p.$('#dp-out [data-row=chats] .oacts a[href^="https://wa.me/"]');
  assert.deepEqual([wa.getAttribute('href'), wa.target, wa.rel], ['https://wa.me/?text=' + encodeURIComponent(chats), '_blank', 'noopener']);
  p.api.drawFails = 'all';
  p.$('#dp-out [data-act=fill][data-ch=chats]').click();
  await waitFor(() => hubAsks(p).length === 2, 3000, 'the second message');
  assert.equal(hubAsks(p)[1].channel, 'hylo');
  assert.equal(hubAsks(p)[1].draft.imageDataUrl, '', 'no image');
  assert.equal(hubAsks(p)[1].draft.text, chats);
  await waitFor(() => fillNoteOf(p, 'chats'), 2000, 'the note');
  assert.equal(fillNoteOf(p, 'chats').textContent, OPENED('Hylo') + " The flyer wasn't ready, so add it there yourself.");
  assert.deepEqual(p.api.opens[1], { type: 'open', channel: 'hylo' });

  // the helper can't open a site (no group link in its Options yet): its sentence shows, with a warning
  p.api.drawFails = '';
  p.api.answer = { ok: false, error: 'Add the Facebook group link in the helper\u2019s Options first.' };
  p.set('#add-ch', 'facebook');
  p.$('#dp-out [data-act=approve][data-ch=facebook]').click();
  assert.deepEqual(acts(p, 'facebook'), ['Open & fill', 'Copy text', 'Mark as posted']);
  // right after the Hylo answer: the helper takes one site at a time, 1.5 s apart, so the page waits out the rest of that
  // moment instead of getting "Still opening the last one"
  p.$('#dp-out [data-act=fill][data-ch=facebook]').click();
  assert.equal(label(p.$('#dp-out [data-act=fill][data-ch=facebook]')), 'Preparing…');
  await waitFor(() => fillNoteOf(p, 'facebook'), 4000, 'the error note');
  assert.ok(sentAt(p, 2) - sentAt(p, 1) >= 1500, 'sent once the helper was ready for it');
  assert.equal(p.api.opens.length, 3, 'the helper took it');
  assert.ok(fillNoteOf(p, 'facebook').classList.contains('bad'));
  assert.equal(fillNoteOf(p, 'facebook').textContent, 'Add the Facebook group link in the helper\u2019s Options first.');
  assert.ok(fillNoteOf(p, 'facebook').querySelector('use[href="#i-alert-triangle"]'));
  assert.equal(p.$('#toast').textContent, 'Add the Facebook group link in the helper\u2019s Options first.');
  assert.ok(!activity(p, 'w7').includes('Phil opened Facebook with the Posting Helper'), 'nothing opened, nothing logged');
  // the same site again straight away (a double click is what the helper ignores): it waits, then the helper answers
  p.api.answer = { ok: true };
  p.$('#dp-out [data-act=fill][data-ch=facebook]').click();
  await waitFor(() => fillNoteOf(p, 'facebook') && !fillNoteOf(p, 'facebook').classList.contains('bad'), 4000, 'Facebook to open');
  assert.equal(fillNoteOf(p, 'facebook').textContent, OPENED('Facebook'));
  assert.ok(sentAt(p, 3) - sentAt(p, 2) >= 1500);
  assert.deepEqual(p.api.opens.at(-1), { type: 'open', channel: 'facebook' });
  // changed text goes back to review, and the old note goes with that approval
  p.set('#ta-w7-facebook', p.$('#ta-w7-facebook').value + ' Bring gloves!');
  p.$('#dp-out [data-act=approve][data-ch=facebook]').click();
  assert.ok(!fillNoteOf(p, 'facebook'), 'a new approval starts with no note');

  // Instagram: its square image and the caption
  p.$('#dp-out [data-act=approve][data-ch=instagram]').click();
  assert.deepEqual(acts(p, 'instagram'), ['Download image', 'Copy caption', 'Mark as posted', NO_LINK], 'nothing to fill on Instagram');
  const n = p.api.downloads.length;
  p.$('#dp-out [data-row=instagram] button[data-dl=ig]').click();
  await waitFor(() => p.api.downloads.length === n + 1, 3000, 'the Instagram image');
  assert.equal(p.api.downloads.at(-1).name, `ebpg-opc-garden-work-party-${dateOf(p, 'w7')}-instagram-post.png`);
  assert.equal(p.api.drawn.at(-1).cls, 'art ig');
  assert.deepEqual([p.api.drawn.at(-1).opts.width, p.api.drawn.at(-1).opts.height], [1080, 1080]);
  p.$('#dp-out [data-act=copy][data-ch=instagram]').click();
  await waitFor(() => p.api.copied.includes(postText(p, 'w7', 'instagram')), 2000, 'the caption on the clipboard');
  checkIcons(p, 'the Posting Helper rows');
  await waitFor(p.idle, 2000, 'saves to finish');
  p.noErrors();
});

test("with the Posting Helper: a draft event's flyer stays here, since it says to publish it and has no link", async t => {
  const p = await openPage(t, withHelper);
  await signIn(p, 'Phil');
  await outreach(p, 'm2');
  assert.match(p.$('#detail .hstrip .art.flyer').textContent, /Publish to get a QR code/, 'the draft flyer on screen');
  p.w.htmlToImage = p.api.drawer;
  p.$('#dp-out [data-act=approve][data-ch=partiful]').click();
  const n = p.api.drawn.length;
  p.$('#dp-out [data-act=fill][data-ch=partiful]').click();
  assert.equal(label(p.$('#dp-out [data-act=fill][data-ch=partiful]')), 'Opening…', 'no flyer to make');
  await waitFor(() => hubAsks(p).length === 1, 3000, 'the message to the helper');
  const { draft: d } = hubAsks(p)[0];
  assert.equal(d.imageDataUrl, '', 'no image');
  assert.equal(d.eventUrl, '', 'no public page yet');
  assert.equal(d.text, postText(p, 'm2', 'partiful'));
  assert.equal(p.api.drawn.length, n, 'the flyer was not drawn');
  assert.ok(!JSON.stringify(p.api.saved).includes('Publish to get a QR code'));
  await waitFor(() => fillNoteOf(p, 'partiful'), 2000, 'the note');
  assert.equal(fillNoteOf(p, 'partiful').textContent, OPENED('Partiful') + ' Publish the event here first to include the flyer and its QR code, or add an image on Partiful yourself.');
  await waitFor(p.idle, 2000, 'saves to finish');
  p.noErrors();
});

test('with the Posting Helper: text changed while the flyer is drawn goes back to review, and the helper gets nothing', async t => {
  const p = await openPage(t, withHelper);
  await signIn(p, 'Phil');
  await outreach(p, 'w7');
  await sleep(50); // the pop-up puts focus on Close as it opens
  p.$('#dp-out [data-row=partiful] [data-act=toggle]').click();
  p.$('#dp-out [data-act=approve][data-ch=partiful]').click();
  // a slow flyer: it comes when the test says
  let release; const slow = new Promise(ok => { release = ok; });
  p.w.htmlToImage = { toPng: async () => { await slow; return PNG_1PX; } };
  p.$('#dp-out [data-act=fill][data-ch=partiful]').click();
  assert.equal(label(p.$('#dp-out [data-act=fill][data-ch=partiful]')), 'Preparing…');
  const ta = p.$('#ta-w7-partiful');
  ta.focus();
  p.set('#ta-w7-partiful', ta.value + ' Bring a friend!');
  assert.ok(p.$('#dp-out [data-row=partiful]').classList.contains('review'), 'back to review');
  release();
  await waitFor(() => p.api.toasts.includes('The text changed, so approve it again before Open & fill.'), 3000, 'the toast');
  await sleep(100);
  assert.equal(hubAsks(p).length, 0, 'nothing went to the helper');
  assert.equal(p.api.opens.length, 0, 'no site opened');
  assert.ok(!fillNoteOf(p, 'partiful'), 'no note');
  assert.ok(!activity(p, 'w7').includes('Phil opened Partiful with the Posting Helper'));
  assert.equal(p.d.activeElement && p.d.activeElement.id, 'ta-w7-partiful', 'the text box keeps the focus');
  // approved again, it goes with the new text
  p.w.htmlToImage = p.api.drawer;
  p.$('#dp-out [data-act=approve][data-ch=partiful]').click();
  p.$('#dp-out [data-act=fill][data-ch=partiful]').click();
  await waitFor(() => hubAsks(p).length === 1, 3000, 'the message to the helper');
  assert.match(hubAsks(p)[0].draft.text, /Bring a friend!$/);
  await waitFor(() => fillNoteOf(p, 'partiful'), 2000, 'the note');
  await waitFor(p.idle, 2000, 'saves to finish');
  p.noErrors();
});

test('without the Posting Helper: Copy stays, and a link opens the install steps with the zip from the site', async t => {
  const p = await openPage(t);
  assert.equal(p.d.documentElement.dataset.ebpgPoster, undefined);
  await signIn(p, 'Phil');
  await outreach(p, 'w7');
  p.$('#dp-out [data-act=approve][data-ch=partiful]').click();
  assert.deepEqual(acts(p, 'partiful'), ['Copy text', 'Open Partiful', 'Mark as posted']);
  assert.ok(!p.$('[data-act=fill]'), 'no Open & fill');
  const tog = p.$('#helper-tog');
  assert.equal(tog.textContent, 'Fill forms automatically with the Posting Helper');
  assert.ok(tog.querySelector('svg.ic[aria-hidden="true"] use[href="#i-wand"]'));
  assert.equal(tog.tagName, 'BUTTON');
  assert.deepEqual([tog.getAttribute('aria-expanded'), tog.getAttribute('aria-controls')], ['false', 'helper-body']);
  assert.ok(p.$('#helper-body').hidden, 'closed to start with');
  tog.click();
  const open = p.$('#helper-tog'), body = p.$('#helper-body');
  assert.equal(open.getAttribute('aria-expanded'), 'true');
  assert.equal(p.d.activeElement, open, 'focus stays on the link');
  assert.ok(!body.hidden && p.visible(body));
  assert.equal(body.getAttribute('role'), 'region');
  assert.equal(p.d.getElementById(body.getAttribute('aria-labelledby')).textContent, 'Posting Helper for Chrome');
  const zip = body.querySelector('a[download]');
  assert.equal(zip.getAttribute('href'), 'http://localhost:8766/ebpg-posting-helper.zip', 'the zip next to the page');
  assert.equal(zip.getAttribute('download'), 'ebpg-posting-helper.zip');
  assert.equal(zip.textContent, 'Download the Posting Helper');
  assert.deepEqual([...body.querySelectorAll('ol > li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()), [
    "Download the Posting HelperIt's a .zip file. Double-click it to unzip it.",
    'In Chrome, type chrome://extensions in the address bar.',
    'Turn on Developer mode (top right).',
    'Click Load unpacked and pick the unzipped folder, the one with manifest.json in it.',
    'Reload this page. Open & fill shows up next to each site once a post is approved.']);
  assert.ok(!/prototype|sample|demo|simulated/i.test(body.textContent), 'plain words');
  checkIcons(p, 'the Posting Helper steps');
  // it stays open while the list redraws, and the link closes it
  p.$('#dp-out [data-act=approve][data-ch=chats]').click();
  assert.ok(!p.$('#helper-body').hidden, 'still open after a redraw');
  assert.deepEqual(acts(p, 'chats'), ['Copy text', 'Share to WhatsApp', 'Mark as posted', NO_LINK]);
  p.$('#helper-tog').click();
  assert.ok(p.$('#helper-body').hidden);
  // the Help page has the same steps
  p.$('#m-x').click();
  p.$('.tabs a[data-tab=help]').click();
  assert.equal(p.$('#hp-helper').textContent, 'Filling in Partiful and the other sites');
  assert.equal(p.$('#help-helper a[download]').getAttribute('href'), 'http://localhost:8766/ebpg-posting-helper.zip');
  assert.ok(!p.$('#help-helper #helper-h'), 'under the section heading');
  await waitFor(p.idle, 2000, 'saves to finish');
  p.noErrors();
  // someone without "Approve & post" has nothing to fill, so no link
  const q = await openPage(t, null, p.g);
  await signIn(q, 'Kalynn');
  await outreach(q, 'w7');
  assert.ok(!q.$('#helper-tog'));
  q.noErrors();
});

test('the site serves the Posting Helper zip that build.py copied from chrome-extension/dist', () => {
  assert.ok(fs.existsSync(ZIP_SITE), 'site/ebpg-posting-helper.zip (build.py makes it)');
  const zip = fs.readFileSync(ZIP_SITE);
  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304', 'a zip file');
  assert.ok(zip.includes(Buffer.from('manifest.json')) && zip.includes(Buffer.from('src/hub-bridge.js')), 'with the extension in it');
  assert.ok(!zip.includes(Buffer.from('node_modules/')) && !zip.includes(Buffer.from('tests/')), 'and only what Chrome needs');
  if (fs.existsSync(ZIP_EXT)) assert.ok(zip.equals(fs.readFileSync(ZIP_EXT)), 'the same zip the extension builds');
});

test('the prototype artifact never finds the helper: Copy stays, and the install steps link to the zip on the public site', async t => {
  const p = loadPage(t, ARTIFACT, 'https://artifact.example/hub');
  await waitFor(() => p.shown('#p-landing'), 2000, 'the artifact landing page');
  p.$('#signin-top').click();
  p.$('#si-google').click();
  p.$('#tiles [data-open="w7"]').click();
  p.$('#detail [data-dtab="outreach"]').click();
  p.$('#dp-out [data-act=approve][data-ch=partiful]').click();
  assert.deepEqual(acts(p, 'partiful'), ['Copy text', 'Open Partiful', 'Mark as posted']);
  // the artifact has no Channels tab, so its copy-and-paste channels open their sites instead of saying to add a link there
  p.$('#dp-out [data-row=chats] [data-act=toggle]').click();
  assert.equal(p.$('#dp-out [data-row=chats] .obody a.hint').href, 'https://www.hylo.com/');
  p.$('#dp-out [data-act=approve][data-ch=instagram]').click();
  p.$('#dp-out [data-act=approve][data-ch=chats]').click();
  assert.deepEqual(acts(p, 'instagram'), ['Download image', 'Copy caption', 'Open Instagram', 'Mark as posted']);
  assert.deepEqual(acts(p, 'chats'), ['Copy text', 'Open WhatsApp & Hylo chats', 'Share to WhatsApp', 'Mark as posted']);
  assert.ok(!p.$('#dp-out .nolink') && !/Channels tab/.test(p.$('#dp-out').textContent), 'no Channels tab hint');
  p.$('#helper-tog').click();
  assert.equal(p.$('#helper-body a[download]').getAttribute('href'), 'https://ebpg-event-hub.netlify.app/ebpg-posting-helper.zip');
  // the helper only runs on the Event Hub's own site, so the last step sends people there instead of saying to reload
  const last = p.$('#helper-body ol > li:last-child');
  assert.equal(last.textContent.replace(/\s+/g, ' ').trim(), 'Open the Event Hub at ebpg-event-hub.netlify.app. Open & fill shows up there once a post is approved.');
  const hub = last.querySelector('a');
  assert.deepEqual([hub.getAttribute('href'), hub.target, hub.rel], ['https://ebpg-event-hub.netlify.app/', '_blank', 'noopener']);
  assert.ok(hub.querySelector('svg.ic[aria-hidden="true"] use[href="#i-out"]'));
  assert.deepEqual(p.api.calls, [], 'the artifact calls no server');
  p.noErrors();
});

/* ---------- the volunteer form: what it asks, sending it, Try again, and the Get involved cards ---------- */
const fromMock = (g, name) => JSON.parse(JSON.stringify(require('vm').runInContext(name, g.ctx))); // a const in Code.js, as plain data
const volRowsOf = g => { const [head, ...rows] = g.tab('Volunteers'); return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : r[i]]))); };
const joinCalls = p => p.api.sent.filter(x => x.fn === 'addVolunteer').map(x => x.args[0]);

test('volunteer form: name, email and phone, the best way to reach you, its choices (the same as the Sheet keeps), the email list, and a honeypot', async t => {
  const p = await openPage(t);
  assert.deepEqual([p.$('#vj-name').required, p.$('#vj-name').getAttribute('autocomplete'), p.$('#vj-name').maxLength], [true, 'name', 80]);
  assert.deepEqual([p.$('#vj-email').type, p.$('#vj-email').getAttribute('autocomplete')], ['email', 'email']);
  assert.deepEqual([p.$('#vj-phone').type, p.$('#vj-phone').getAttribute('inputmode'), p.$('#vj-phone').getAttribute('autocomplete')], ['tel', 'tel', 'tel']);
  const label = i => i.closest('label').textContent.trim();
  assert.deepEqual(p.$$('#vj-picks input').map(label), fromMock(p.g, 'VOL_HELP'), "I'd like to help with: the Sheet's own list");
  assert.ok(['Adopt a plant', 'Host a project', 'Partner organization'].every(l => p.$$('#vj-picks input').map(label).includes(l)));
  assert.deepEqual(p.$$('#vj-free input').map(i => i.value), fromMock(p.g, 'VOL_FREE'));
  assert.deepEqual(p.$$('#vj-heard option').map(o => o.value), ['', ...fromMock(p.g, 'VOL_HEARD')]);
  assert.deepEqual(p.$$('input[name=vj-best]').map(i => [i.type, i.value]), fromMock(p.g, 'VOL_BEST').map(v => ['radio', v]));
  assert.equal(p.$('#vj-note').maxLength, 1000);
  assert.ok(p.$('#vj-list').type === 'checkbox' && !p.$('#vj-list').checked, 'the email list is opt-in');
  assert.match(p.$('#vj-list').closest('label').textContent, /^Add me to the Guild email list/);
  // the honeypot: a box only bots fill in
  const hp = p.$('#joinf input[name=website]');
  assert.deepEqual([hp.tabIndex, hp.getAttribute('autocomplete'), !!hp.closest('[aria-hidden="true"]')], [-1, 'off', true]);
  assert.equal(p.w.getComputedStyle(hp.closest('.vj-hp')).left, '-10000px', 'off the screen');
  assert.ok(p.$('#vj-opened').type === 'hidden' && Number(p.$('#vj-opened').value) > START - 1000, 'when the form was opened');
  checkIcons(p, 'the volunteer form');
  // what the page checks before sending
  const submit = () => p.$('#joinf button[type=submit]').click(), err = () => p.$('#vj-err').textContent;
  p.set('#vj-name', 'Sam'); submit();
  assert.equal(err(), 'Add an email or phone number so an organizer can reach you.');
  assert.equal(p.d.activeElement, p.$('#vj-email'));
  p.set('#vj-email', 'sam@example'); submit();
  assert.equal(err(), "That email address doesn't look right. Please check it.");
  p.set('#vj-email', ''); p.set('#vj-phone', '555-01'); submit();
  assert.equal(err(), 'Please check your phone number. It needs at least 7 digits.');
  assert.equal(p.d.activeElement, p.$('#vj-phone'));
  p.set('#vj-phone', '510 555 0101'); p.$('input[name=vj-best][value=Email]').click(); submit();
  assert.equal(err(), 'Add your email, or pick Text as the best way to reach you.');
  p.$('input[name=vj-best][value=Text]').click(); p.$('#vj-list').click(); submit();
  assert.equal(err(), 'Add your email to get the Guild email list.');
  p.$('#vj-list').click(); p.set('#vj-name', 'Sam <3'); submit();
  assert.equal(err(), "Please write your name with letters, spaces and . ' - only.");
  p.set('#vj-name', 'Sam'); submit();
  assert.equal(err(), 'Pick at least one way you would like to help.');
  assert.deepEqual(joinCalls(p), [], 'nothing sent yet');
  p.noErrors();
});

test('sending: Sending… while the Sheet saves it, then a thank-you with the next event, Add to calendar and Directions; every answer reaches the Sheet', async t => {
  const p = await openPage(t, null, await seededSheet(t));
  settled(p);
  p.set('#vj-name', '  Maya   Ortiz '); p.set('#vj-email', 'maya@example.org'); p.set('#vj-phone', '(510) 555-0101');
  p.$('input[name=vj-best][value=Text]').click();
  p.$('#vj-picks input[value=workdays]').click(); p.$('#vj-picks input[value=plant]').click();
  p.$('#vj-free input[value="Weekend mornings"]').click(); p.$('#vj-free input[value="One-off projects"]').click();
  p.set('#vj-heard', 'A friend'); p.set('#vj-note', 'I speak Spanish'); p.$('#vj-list').click();
  p.api.latency = 150;
  p.$('#vj-send').click();
  const btn = p.$('#vj-send');
  assert.deepEqual([btn.disabled, btn.textContent, btn.getAttribute('aria-busy')], [true, 'Sending…', 'true']);
  assert.ok(btn.querySelector('use[href="#i-loader"]'));
  assert.equal(p.$('#vj-status').textContent, 'Sending your sign-up…', 'said to screen readers too');
  p.$('#joinf').dispatchEvent(new p.w.Event('submit', { cancelable: true })); // Enter pressed again
  assert.ok(!p.shown('#joined') && p.shown('#joinf'), 'no thank-you before the Sheet has it');
  await waitFor(() => p.shown('#joined'), 3000, 'the thank-you');
  assert.equal(joinCalls(p).length, 1, 'sent once');
  const sent = joinCalls(p)[0];
  assert.deepEqual({ ...sent, id: undefined, elapsed: undefined }, { name: 'Maya Ortiz', email: 'maya@example.org', phone: '(510) 555-0101', best: 'Text', help: ['Garden work days', 'Adopt a plant'], free: ['Weekend mornings', 'One-off projects'], heard: 'A friend', note: 'I speak Spanish', list: true, event: '', id: undefined, elapsed: undefined, website: '' });
  assert.match(sent.id, /^[A-Za-z0-9-]{8,64}$/);
  assert.ok(sent.elapsed >= 10000, 'how long the form was open');
  // the thank-you
  assert.match(p.$('#vj-thanks').textContent, /^Thanks, Maya!$/);
  assert.equal(p.d.activeElement, p.$('#vj-thanks'), 'focus moves to the thank-you');
  const next = p.$('#nextup a.nxcard');
  assert.equal(p.$('#joined .vj-ev').textContent, next.querySelector('b').textContent, 'Next up: the next published event');
  assert.equal(p.$('#joined .vj-ev').dataset.ev, next.dataset.ev);
  assert.match(p.$('#joined .vj-next').textContent, /^Next up.+\w+day, \w+ \d{1,2}, \d{1,2}:\d\d [AP]M–\d{1,2}:\d\d [AP]M/, 'the day and time');
  assert.match(p.$('#joined .vj-next').textContent, /Oakland Peace Center/);
  assert.match(p.$('#vj-gcal').href, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=/);
  assert.match(p.$('#vj-dir').href, /^https:\/\/(www\.google\.com\/maps|maps\.)/);
  p.$('#vj-ics').click();
  assert.match(p.api.downloads.at(-1).name, /^ebpg-\d{4}-\d{2}-\d{2}-.+\.ics$/);
  checkIcons(p, 'the thank-you');
  // the Sheet has every answer
  const r = await waitFor(() => volRowsOf(p.g).find(x => x.name === 'Maya Ortiz'), 2000, 'the row');
  assert.deepEqual([r.contact, r.email, r.phone, r['best way'], r['wants to help with'], r.free, r['heard from'], r['email list'], r.note],
    ['maya@example.org', 'maya@example.org', '(510) 555-0101', 'Text', 'Garden work days, Adopt a plant', 'Weekend mornings, One-off projects', 'A friend', 'yes', 'I speak Spanish']);
  assert.match(r.id, /^[0-9a-f]{8}$/);
  // and the next person starts with an empty form
  const opened = Number(p.$('#vj-opened').value);
  p.$('#vj-again').click();
  assert.ok(p.shown('#joinf') && !p.shown('#joined'));
  assert.equal(p.d.activeElement, p.$('#vj-name'));
  assert.deepEqual([p.$('#vj-name').value, p.$('#vj-email').value, p.$$('#joinf input:checked').length, p.$('#vj-heard').value], ['', '', 0, '']);
  assert.ok(Number(p.$('#vj-opened').value) > opened, 'opened again just now');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test("when the Sheet doesn't answer, the form keeps everything with Try again, which sends the same id so the Sheet keeps it once", async t => {
  const p = await openPage(t, null, await seededSheet(t));
  settled(p);
  p.set('#vj-name', 'Maya Ortiz'); p.set('#vj-email', 'maya@example.org'); p.set('#vj-note', 'Weekends');
  p.$('#vj-picks input[value=host]').click();
  p.api.fail = 'addVolunteer';
  p.$('#vj-send').click();
  await waitFor(() => p.shown('#vj-err') && p.$('#vj-retry'), 3000, 'the error');
  assert.equal(p.$('#vj-err').getAttribute('role'), 'alert');
  assert.match(p.$('#vj-err > span').textContent, /^We couldn't reach the Guild Sheet, so your sign-up didn't go through\. Your answers are still here\.$/);
  assert.ok(p.$('#vj-retry use[href="#i-rotate-ccw"]') && p.$('#vj-retry').textContent === 'Try again');
  assert.equal(p.d.activeElement, p.$('#vj-retry'));
  assert.ok(p.shown('#joinf') && !p.shown('#joined'), 'no thank-you');
  assert.deepEqual([p.$('#vj-name').value, p.$('#vj-email').value, p.$('#vj-note').value, p.$('#vj-picks input[value=host]').checked], ['Maya Ortiz', 'maya@example.org', 'Weekends', true], 'everything typed is still there');
  assert.deepEqual([p.$('#vj-send').disabled, p.$('#vj-send').textContent], [false, 'Join the list']);
  assert.equal(volRowsOf(p.g).length, 0);
  // the send got through after all, but its answer didn't come back
  p.g.ctx.addVolunteer(joinCalls(p)[0]);
  assert.equal(volRowsOf(p.g).length, 1);
  p.$('#vj-retry').click();
  await waitFor(() => joinCalls(p).length === 2 && p.idle() && p.$('#vj-retry'), 3000, 'the second failure');
  p.api.fail = '';
  p.$('#vj-retry').click();
  await waitFor(() => p.shown('#joined'), 3000, 'the thank-you once it goes through');
  const ids = joinCalls(p).map(v => v.id);
  assert.equal(ids.length, 3);
  assert.ok(ids.every(id => id === ids[0]), 'the same id every time');
  assert.equal(volRowsOf(p.g).length, 1, 'one row');
  assert.equal(p.g.mail.filter(m => /Welcome/.test(m.subject)).length, 1, 'one welcome');
  // the Sheet's own words, for something only it can tell: 60 sign-ups in these 10 minutes already
  p.$('#vj-again').click(); settled(p);
  assert.ok(!p.$('#vj-retry'), 'a fresh form has no old error');
  p.set('#vj-name', 'Ana Ruiz'); p.set('#vj-email', 'ana@example.org'); p.$('#vj-picks input').click();
  p.g.cache['joins:' + Math.floor(p.w.Date.now() / 6e5)] = { v: '60', until: Number.MAX_SAFE_INTEGER };
  p.$('#vj-send').click();
  await waitFor(() => p.$('#vj-retry'), 3000, 'the error');
  assert.equal(p.$('#vj-err > span').textContent, 'Lots of sign-ups right now. Please try again in a few minutes.');
  assert.notEqual(joinCalls(p).at(-1).id, ids[0], 'a new sign-up has a new id');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('Host a project and Become a partner open the form with that choice ticked and the note ready', async t => {
  const p = await openPage(t);
  const host = p.$('#involved a[data-join=host]'), partner = p.$('#involved a[data-join=partner]');
  assert.equal(host.getAttribute('href'), '#join', 'a plain link without the script, or in a new tab');
  assert.ok(host.closest('li.linkcard') && partner.closest('li.linkcard'));
  assert.ok(host.querySelector('.go use[href="#i-arrow-down"]'));
  host.click();
  assert.ok(p.$('#vj-picks input[value=host]').checked, 'Host a project is ticked');
  assert.equal(p.d.activeElement, p.$('#vj-note'), 'the note has focus');
  assert.match(p.$('#vj-note').placeholder, /^Tell us about your project/);
  assert.equal(p.w.location.hash, '#join');
  partner.click();
  assert.ok(p.$('#vj-picks input[value=partner]').checked && p.$('#vj-picks input[value=host]').checked);
  assert.match(p.$('#vj-note').placeholder, /^Tell us about your group/);
  // a Cmd-click is left to the browser
  p.$('#vj-picks input[value=partner]').click();
  partner.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  assert.ok(!p.$('#vj-picks input[value=partner]').checked);
  // after a sign-up, the card opens a fresh form
  settled(p); p.set('#vj-name', 'Kai'); p.set('#vj-email', 'kai@example.org');
  p.$('#vj-send').click();
  await waitFor(() => p.shown('#joined'), 3000, 'the thank-you');
  host.click();
  assert.ok(p.shown('#joinf') && p.$('#vj-name').value === '' && p.$('#vj-picks input[value=host]').checked);
  assert.equal(volRowsOf(p.g)[0]['wants to help with'], 'Host a project');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test("signing up from an event's page sends its id, and the thank-you is about that event", async t => {
  const p = await eventPage(t, 'w7');
  p.$('#pe-join').click();
  settled(p);
  p.set('#vj-name', 'Maya Ortiz'); p.set('#vj-phone', '510 555 0101'); p.$('#vj-picks input').click();
  p.$('#vj-send').click();
  await waitFor(() => p.shown('#joined'), 3000, 'the thank-you');
  assert.equal(joinCalls(p)[0].event, 'w7');
  assert.equal(joinCalls(p)[0].best, 'Text', 'a phone only: a text');
  assert.equal(p.$('#joined .vj-ev').textContent, 'OPC Garden Work Party');
  const r = volRowsOf(p.g).find(x => x.name === 'Maya Ortiz');
  assert.deepEqual([r.event, r.contact, r['best way']], ['w7', '510 555 0101', 'Text']);
  // the event link in the thank-you opens its page here
  p.$('#joined .vj-ev').click();
  assert.ok(p.shown('#p-pubevent') && p.$('#pe-title').textContent === 'OPC Garden Work Party');
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('the Volunteer list shows each answer, escaped', async t => {
  const sheet = await seededSheet(t);
  sheet.clock.now = START + 60e3;
  sheet.ctx.addVolunteer({ name: 'Maya Ortiz', email: 'maya@example.org', phone: '510 555 0101', best: 'Text', help: ['Garden work days', 'Partner organization'], free: ['Weekday evenings'], heard: 'A flyer', list: true, event: 'w7', note: 'Line one\nLine <b>two</b>', id: 'abcdefgh-1', elapsed: 9000 });
  const p = await openPage(t, null, sheet);
  await signIn(p, 'Jessie');
  p.$('.tabs a[data-tab=team]').click();
  const row = p.$$('#vol-tbl tbody tr').find(tr => tr.textContent.includes('Maya Ortiz'));
  assert.ok(row, 'her row');
  const cells = [...row.cells].map(td => td.textContent.trim());
  assert.match(cells[1], /maya@example\.org.*510 555 0101.*Prefers a text.*Email list/);
  assert.equal(cells[2], 'Garden work days Partner organization');
  assert.equal(cells[3], 'Weekday evenings');
  assert.match(cells[4], /^Coming to OPC Garden Work Party.*Heard about us: A flyer.*Line one\nLine <b>two<\/b>$/s);
  assert.ok(!row.querySelector('b b'), 'the note is text');
  checkIcons(p, 'the Volunteer list');
  p.noErrors();
});

/* ---------- new events: type and defaults, copies, hosts; Cancel event; Delete draft; events taken out of the Sheet ---------- */
const evRow = (p, id) => { const [head, ...rows] = p.g.tab('Events'), r = rows.find(x => x[0] === id); return r && Object.fromEntries(head.map((h, i) => [h, r[i]])); };
const formVals = p => ['ed-date', 'ed-start', 'ed-end', 'ed-ls', 'ed-le', 'ed-bring'].map(id => p.$('#' + id).value);
const ticked = (p, name) => p.$$(`#editf input[name=${name}]:checked`).map(i => i.value);
const hostRows = p => p.$$('#host-body .hrow').map(r => [r.querySelector('.hl').textContent, [...r.querySelectorAll('.pp')].map(x => x.lastChild.textContent)]);
// the 10 seconds to undo Delete draft, made short so a test needn't wait them out
const quickUndo = w => { const st = w.setTimeout; w.setTimeout = (f, ms, ...a) => st.call(w, f, ms === 10000 ? 300 : ms, ...a); };
const TEAM_NAMES = ['Jessie', 'Phil', 'Kalynn', 'Sky', 'Karen', 'Meena', 'Ajay', 'Marissa', 'Rob', 'Lauren'];

test('the 4th Sunday after a date: 2026-10-25 gives 2026-11-22, and 2026-11-22 gives 2026-12-27', () => {
  const src = fs.readFileSync(ARTIFACT, 'utf8');
  const helpers = ['iso', 'D', 'addDays'].map(n => src.match(new RegExp(`\\nconst ${n} = [^\\n]*`))[0]).join('');
  const fourthSundayAfter = new Function(helpers + '\n' + src.match(/\nfunction fourthSundayAfter\(s\) \{[\s\S]*?\n\}/)[0] + '\nreturn fourthSundayAfter;')();
  assert.equal(fourthSundayAfter('2026-10-25'), '2026-11-22');
  assert.equal(fourthSundayAfter('2026-11-22'), '2026-12-27');
  assert.equal(fourthSundayAfter('2026-10-24'), '2026-10-25', 'the day before one');
  assert.equal(fourthSundayAfter('2026-12-27'), '2027-01-24', 'into the next year');
});

test('New event: a work day on the next 4th Sunday from 10 to 2, labeled Workday #8; the Type changes the label and the defaults nobody changed', async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  p.$('#new-ev').click();
  await waitFor(() => p.$('#editf #ed-type'), 2000, 'the new event form');
  assert.deepEqual(p.$$('#ed-type option').map(o => [o.value, o.textContent]), [['workday', 'Work day'], ['meeting', 'Community meeting'], ['other', 'Other']]);
  assert.equal(p.$('#ed-type').value, 'workday');
  assert.equal(p.$('#ed-label').textContent, 'Label: Workday #8');
  assert.deepEqual(formVals(p), ['2026-11-22', '10:00', '14:00', '09:00', '14:30', 'water bottle, gloves if you have them'], 'the Sunday after Workday #7');
  assert.deepEqual(ticked(p, 'ed-tag'), ['beginner', 'tools']);
  // the host and co-hosts are picked from the team, and the host can't be a co-host too
  assert.equal(p.$('#ed-host').value, 'Jessie');
  assert.deepEqual(p.$$('#ed-cos input[name=ed-co]').map(i => i.value), TEAM_NAMES);
  assert.deepEqual([ticked(p, 'ed-co'), p.$('#ed-cos input[value="Jessie"]').disabled], [[], true]);
  p.set('#ed-host', 'Phil');
  assert.deepEqual([p.$('#ed-cos input[value="Jessie"]').disabled, p.$('#ed-cos input[value="Phil"]').disabled], [false, true]);
  p.set('#ed-host', 'Jessie');
  // a community meeting: four weeks after Community Meeting #2 (Nov 12), 6 to 8
  p.set('#ed-type', 'meeting');
  assert.equal(p.$('#ed-label').textContent, 'Label: Community Meeting #3');
  assert.deepEqual(formVals(p), ['2026-12-10', '18:00', '20:00', '', '', 'yourself, and a dish to share if you like']);
  assert.deepEqual(ticked(p, 'ed-tag'), ['beginner', 'potluck']);
  // Other: a week from today with no number, and a time typed by hand stays
  p.set('#ed-start', '09:30');
  p.set('#ed-type', 'other');
  assert.equal(p.$('#ed-label').textContent, 'No number for this type');
  assert.deepEqual(formVals(p).slice(0, 3), ['2026-10-31', '09:30', '12:00']);
  p.set('#ed-start', '10:00');
  p.set('#ed-type', 'workday');
  assert.deepEqual([p.$('#ed-label').textContent, ...formVals(p).slice(0, 3)], ['Label: Workday #8', '2026-11-22', '10:00', '14:00']);
  checkIcons(p, 'the new event form');
  p.set('#ed-title', 'OPC Garden Work Party');
  p.$('#editf button[type=submit]').click();
  await waitFor(() => p.api.toasts.includes('Event created as a draft. Only organizers can see it.'), 3000, 'the new event to be saved');
  const first = p.api.sent.find(c => c.fn === 'saveEvent'), id = first.args[1].id;
  assert.equal(first.args[1].created, true, 'its first save says it is new, so the Sheet adds it');
  assert.equal(first.args[1].data.created, undefined, 'and that is not kept in the plan');
  const row = evRow(p, id);
  assert.deepEqual([row.label, row.title, row.date, row.start, row.end, row.status, row.host], ['Workday #8', 'OPC Garden Work Party', '2026-11-22', '10:00', '14:00', 'draft', 'Jessie']);
  assert.deepEqual([JSON.parse(row["data (don't edit)"]).series, JSON.parse(row["data (don't edit)"]).num], ['workday', 8]);
  // the saves after it leave created out
  p.$('#edit-ev').click();
  await waitFor(() => p.$('#editf #ed-title'), 2000, 'the edit form');
  assert.ok(!p.$('#ed-type'), 'the Type is picked when the event is made');
  p.set('#ed-title', 'Fall Work Party');
  p.$('#editf button[type=submit]').click();
  await waitFor(() => evRow(p, id).title === 'Fall Work Party' && p.idle(), 3000, 'the edit in the Sheet');
  assert.equal(p.api.sent.filter(c => c.fn === 'saveEvent' && c.args[1].id === id).at(-1).args[1].created, undefined);
  assert.equal(p.g.tab('Events').filter(r => r[0] === id).length, 1);
  p.$('#m-x').click();
  // the next work day after Workday #8 (Nov 22) is Dec 27, Workday #9
  p.$('#new-ev').click();
  await waitFor(() => p.$('#editf #ed-type'), 2000, 'the new event form again');
  assert.deepEqual([p.$('#ed-label').textContent, p.$('#ed-date').value], ['Label: Workday #9', '2026-12-27']);
  p.$('#editf [data-cancel]').click();
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test("Start from: a copy is a draft with the copied event's channels, its tasks open with who did them last time, and the next number", async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  p.$('#new-ev').click();
  await waitFor(() => p.$('#editf #ed-from'), 2000, 'the new event form');
  p.set('#ed-from', 'w7');
  await waitFor(() => p.$('#ed-from').value === 'w7' && p.$('#ed-title').value === 'OPC Garden Work Party', 2000, 'the copy of Workday #7');
  assert.equal(p.d.activeElement, p.$('#ed-from'), 'focus stays on Start from');
  assert.deepEqual([p.$('#ed-type').value, p.$('#ed-label').textContent, ...formVals(p).slice(0, 3)], ['workday', 'Label: Workday #8', '2026-11-22', '10:00', '14:00']);
  assert.deepEqual(p.$$('#editf input[name=ed-status]').map(r => r.checked), [true, false], 'a draft');
  assert.deepEqual([p.$('#ed-host').value, ticked(p, 'ed-co')], ['Jessie', ['Phil']], "Workday #7's host and co-host");
  p.$('#editf button[type=submit]').click();
  await waitFor(() => p.api.toasts.includes('Event created as a draft. Only organizers can see it.'), 3000, 'the copy to be saved');
  const id = p.api.sent.find(c => c.fn === 'saveEvent' && c.args[1].created).args[1].id;
  await waitFor(() => p.g.tab('Posts').some(r => r[0] === id) && p.idle(), 3000, 'its Posts rows');
  assert.deepEqual(p.g.tab('Posts').filter(r => r[0] === id).map(r => [r[1], r[2]]), [['partiful', 'review'], ['ggroup', 'review'], ['calendar', 'review'], ['instagram', 'review'], ['chats', 'review']],
    "Workday #7's channels (no Facebook, which new events start with), as drafts");
  assert.deepEqual(p.g.tab('Bringing').filter(r => r[0] === id).map(r => [r[1], r[2], r[3], r[5]]), [
    ['Bring plates, cups, napkins, utensils', '', 'open', 'Phil'], ['Snacks and water station', '', 'open', 'Karen'], ['Nametags and sign-in sheet', '', 'open', 'Meena'], ['Make a parking sign', '', 'open', '']],
  'every task, open again, with who did it last time');
  assert.deepEqual(p.$$('#tasks-body .last').map(x => x.textContent), ['Last time: Phil', 'Last time: Karen', 'Last time: Meena']);
  assert.deepEqual([evRow(p, id).label, evRow(p, id).status], ['Workday #8', 'draft']);
  p.$('#m-x').click();
  // a copy of an event with nothing posted on record gets the channels new events start with; a meeting's copy is a meeting
  p.$('#new-ev').click();
  await waitFor(() => p.$('#editf #ed-from'), 2000, 'the new event form again');
  p.set('#ed-from', 'm1');
  await waitFor(() => p.$('#ed-title').value === 'OPC Community Meeting', 2000, 'the copy of Community Meeting #1');
  assert.deepEqual([p.$('#ed-type').value, p.$('#ed-label').textContent, ...formVals(p).slice(0, 3)], ['meeting', 'Label: Community Meeting #3', '2026-12-10', '18:00', '20:00']);
  p.set('#ed-from', 'w6');
  await waitFor(() => p.$('#ed-type').value === 'workday', 2000, 'the copy of Workday #6');
  assert.deepEqual([p.$('#ed-label').textContent, p.$('#ed-date').value], ['Label: Workday #9', '2026-12-27'], 'after Workday #8');
  // back to a blank event of the type last picked
  p.set('#ed-from', '');
  await waitFor(() => p.$('#ed-title').value === '', 2000, 'a blank event');
  assert.deepEqual([p.$('#ed-type').value, p.$('#ed-label').textContent, p.$('#ed-date').value], ['workday', 'Label: Workday #9', '2026-12-27']);
  p.set('#ed-from', 'w6');
  await waitFor(() => p.$('#ed-title').value === 'OPC Garden Work Party', 2000, 'Workday #6 again');
  p.$('#editf button[type=submit]').click();
  const id2 = await waitFor(() => (p.api.sent.find(c => c.fn === 'saveEvent' && c.args[1].created && c.args[1].id !== id) || {}).args?.[1].id, 3000, 'the second copy');
  await waitFor(() => p.g.tab('Posts').some(r => r[0] === id2) && p.idle(), 3000, 'its Posts rows');
  assert.deepEqual(p.g.tab('Posts').filter(r => r[0] === id2).map(r => r[1]), ['partiful', 'ggroup', 'calendar', 'facebook', 'instagram', 'chats']);
  p.noErrors();
});

test("Edit event: the host and co-hosts are picked from the team, and saving changes only those roles, keeping the plan's others", async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  p.$('[data-when="past"]').click();
  p.$('#tiles [data-open="w2"]').click();
  await waitFor(() => p.$('#detail #edit-ev'), 2000, 'Workday #2 to open');
  assert.deepEqual(hostRows(p), [['Host', ['Jessie']], ['Co-hosts', ['Kalynn', 'Phil']], ['Neighborhood outreach', ['Marissa']]], "Marissa's outreach is its own role");
  p.$('#edit-ev').click();
  await waitFor(() => p.$('#editf #ed-host'), 2000, 'the edit form');
  assert.deepEqual([p.$('#ed-host').value, ticked(p, 'ed-co')], ['Jessie', ['Phil', 'Kalynn']]);
  p.$('#ed-cos input[value="Sky"]').click();
  p.$('#editf button[type=submit]').click();
  await waitFor(() => evRow(p, 'w2')['co-hosts'] === 'Phil, Kalynn, Sky' && p.idle(), 3000, 'the co-hosts in the Sheet');
  assert.deepEqual(JSON.parse(evRow(p, 'w2')["data (don't edit)"]).plan.roles, [['Host', ['Jessie']], ['Co-hosts', ['Phil', 'Kalynn', 'Sky']], ['Neighborhood outreach', ['Marissa']]]);
  assert.deepEqual(hostRows(p), [['Host', ['Jessie']], ['Co-hosts', ['Phil', 'Kalynn', 'Sky']], ['Neighborhood outreach', ['Marissa']]]);
  // a co-host typed into the Sheet by hand: the other roles stay, and the name is a choice in the form
  setEvCell(p.g, 'w2', 'co-hosts', 'Phil, Dana');
  await readAgain(p);
  assert.deepEqual(hostRows(p), [['Host', ['Jessie']], ['Co-hosts', ['Phil', 'Dana']], ['Neighborhood outreach', ['Marissa']]]);
  p.$('#edit-ev').click();
  await waitFor(() => p.$('#editf #ed-host'), 2000, 'the edit form');
  assert.deepEqual(ticked(p, 'ed-co'), ['Phil', 'Dana']);
  p.$('#editf [data-cancel]').click();
  await waitFor(p.idle, 2000, 'calls to finish');
  p.noErrors();
});

test('Cancel event: Workday #7 leaves the landing, its calendar entry is deleted, its tile goes under Past, and its link says it was cancelled', async t => {
  const sheet = await seededSheet(t);
  const p = await openPage(t, null, sheet);
  await signIn(p, 'Jessie');
  await outreach(p, 'w7');
  for (const ch of ['calendar', 'ggroup']) {
    p.$(`#dp-out [data-act=approve][data-ch=${ch}]`).click();
    p.$(`#dp-out [data-act=post][data-ch=${ch}]`).click();
    await waitFor(() => pill(p, ch) === TEST_SENT, 3000, ch + ' to be sent');
  }
  assert.equal(p.g.calendar.length, 1, 'on the mock calendar');
  p.$('#detail [data-dtab="plan"]').click();
  assert.ok(p.$('#detail #cancel-ev') && !p.$('#detail #delete-ev'), 'a published event is cancelled, not deleted');
  p.$('#cancel-ev').click();
  await waitFor(() => p.$('#dconfirm #dc-why'), 2000, 'the question');
  assert.equal(p.d.activeElement, p.$('#dc-why'));
  assert.equal(p.$('#cancel-ev').getAttribute('aria-expanded'), 'true');
  assert.equal(p.$('#dc-h').textContent, 'Cancel Workday #7? It comes off the public site, comes off the Guild calendar and gets no more reminders. A cancellation notice for Google Group email will wait in Outreach for you to approve and post.');
  checkIcons(p, 'the cancel question');
  // Keep it, or Escape, puts it away
  p.$('#dc-no').click();
  assert.ok(!p.$('#dconfirm') && p.d.activeElement === p.$('#cancel-ev'));
  p.$('#cancel-ev').click();
  p.$('#dc-why').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!p.$('#dconfirm') && !p.$('#modal').hidden, 'the question closes, the pop-up stays');
  p.$('#cancel-ev').click();
  p.set('#dc-why', 'Heavy rain is forecast');
  p.api.latency = 100;
  p.$('#dconfirm button[type=submit]').click();
  const busy = p.$('#dconfirm button[type=submit]');
  assert.deepEqual([busy.disabled, busy.textContent, busy.getAttribute('aria-busy')], [true, 'Cancelling…', 'true']);
  await waitFor(() => p.api.toasts.includes("Cancelled. It's off the public site and the calendar. A cancellation notice is waiting for review in Outreach."), 4000, 'the toast');
  p.api.latency = 0;
  const call = p.api.sent.find(c => c.fn === 'cancelEvent');
  assert.deepEqual(call.args.slice(1), ['w7', 'Heavy rain is forecast', 'Jessie']);
  assert.equal(evRow(p, 'w7').status, 'cancelled');
  assert.deepEqual(p.g.calendar, [], 'the mock calendar entry is deleted');
  assert.ok(!p.$('#dconfirm') && !p.$('#cancel-ev') && !p.$('#publish-ev'), 'nothing more to cancel');
  assert.equal(p.$('#detail .dh .evs').textContent, 'Cancelled');
  assert.equal(p.d.activeElement, p.$('#edit-ev'));
  // Outreach: the Group's notice to approve and post; the Calendar says it came off
  p.$('#detail [data-dtab="outreach"]').click();
  assert.deepEqual([pill(p, 'calendar'), acts(p, 'calendar')], ['Taken off the calendar', []]);
  assert.deepEqual([pill(p, 'ggroup'), acts(p, 'ggroup')], ['Draft · needs review', ['Approve']]);
  p.$('#dp-out [data-row=ggroup] [data-act=toggle]').click();
  assert.equal(p.$('#dp-out [data-row=ggroup] textarea').value, 'Subject: Cancelled: OPC Garden Work Party on Sunday, October 25\n\nHi all,\n\nCancelled: OPC Garden Work Party on Sunday, October 25. Heavy rain is forecast. Sorry for the change. We hope to see you at the next one.\n\nThe East Bay Permaculture Guild');
  assert.ok(!p.$('#add-ch'), 'nothing new to announce');
  assert.deepEqual(p.$$('#log-body li span:last-child').slice(0, 3).map(s => s.textContent), ['Drafted a cancellation notice for Google Group email', "Took the [TEST] entry off the Sheet owner's calendar", 'Jessie cancelled the event: Heavy rain is forecast']);
  assert.equal(p.$('#attn .grow').textContent, '6 drafts to review · 0 approved, ready to post', "the notice, and Community Meeting #2's five drafts");
  checkIcons(p, "a cancelled event's outreach");
  p.$('#m-x').click();
  // its tile: under Past, with a Cancelled badge
  assert.ok(!p.$('#tiles [data-open="w7"]'), 'not under Upcoming');
  p.$('[data-when="past"]').click();
  const tile = p.$('#tiles [data-open="w7"]');
  assert.ok(tile.classList.contains('past'));
  assert.equal(tile.querySelector('.tstat').textContent, 'Cancelled');
  assert.match(tile.getAttribute('aria-label'), /\. Cancelled$/);
  // nothing saved afterwards undoes it
  await sleep(1000);
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.deepEqual(p.api.sent.slice(p.api.sent.indexOf(call) + 1).filter(c => c.fn === 'saveEvent'), [], 'the page already has what the Sheet has');
  // the landing no longer shows it, and its link says it was cancelled
  const q = await openPage(t, null, sheet);
  assert.deepEqual([q.$$('#nextup a.nxcard').length, q.$('#nextup').textContent], [0, "Next dates coming soon. Join the list and we'll tell you."]);
  const e = await eventPage(t, 'w7', null, sheet);
  assert.equal(e.$('.pe-gone h1').textContent, 'This event was cancelled');
  assert.deepEqual(e.$$('.pe-gone > p').map(x => x.textContent), ['Sorry to miss you.', "Next dates coming soon. Join the list and we'll tell you."]);
  assert.ok(!e.$('#p-pubevent').innerHTML.includes('Heavy rain'), 'nothing from the plan');
  checkIcons(e, "a cancelled event's page");
  p.noErrors(); q.noErrors(); e.noErrors();
});

test('Delete draft: gone at once with 10 seconds to Undo, which brings it back; after them the Sheet keeps a deleted tombstone', async t => {
  const p = await openPage(t, quickUndo);
  await signIn(p, 'Jessie');
  // a draft made by mistake
  p.$('#new-ev').click();
  await waitFor(() => p.$('#editf #ed-title'), 2000, 'the new event form');
  p.set('#ed-title', 'Oops');
  p.$('#editf button[type=submit]').click();
  await waitFor(() => p.api.toasts.includes('Event created as a draft. Only organizers can see it.'), 3000, 'the draft to be saved');
  const id = p.api.sent.find(c => c.fn === 'saveEvent' && c.args[1].created).args[1].id;
  assert.ok(p.$('#detail #delete-ev') && !p.$('#detail #cancel-ev'), 'a draft nobody has seen is deleted, not cancelled');
  p.$('#delete-ev').click();
  assert.equal(p.d.activeElement, p.$('#dc-no'), 'focus on the safe choice');
  assert.equal(p.$('#dc-h').textContent, 'Delete this draft? It was never on the public site, so only organizers have seen it. Its tasks, post drafts and activity go too. You can undo it for 10 seconds.');
  p.$('#dc-del').click();
  assert.ok(p.$('#modal').hidden, 'the pop-up closes');
  assert.ok(!p.$(`#tiles [data-open="${id}"]`), 'its tile goes at once');
  assert.ok(!p.$('#undobar').hidden);
  assert.equal(p.$('#undo-msg').textContent, 'Deleted Workday #8.');
  assert.equal(p.d.activeElement, p.$('#undo-btn'), 'Undo has keyboard focus');
  checkIcons(p, 'the Undo bar');
  assert.ok(!p.api.calls.includes('deleteEvent'), 'the Sheet is not told yet');
  p.$('#undo-btn').click();
  assert.ok(p.$('#undobar').hidden);
  assert.equal(p.d.activeElement, p.$(`#tiles [data-open="${id}"]`), 'back, with focus on its tile');
  await waitFor(() => p.api.toasts.includes('Workday #8 is back.'), 2000, 'the toast');
  await sleep(500);
  assert.ok(!p.api.calls.includes('deleteEvent'), 'after Undo the Sheet never hears of it');
  assert.equal(evRow(p, id).status, 'draft');
  // Community Meeting #2, a starter draft: a read of the Sheet during the 10 seconds doesn't bring it back
  for (const t0 of ['m2']) {
    p.$(`#tiles [data-open="${t0}"]`).click();
    (await waitFor(() => p.$('#detail #delete-ev'), 2000, 'its Delete draft')).click();
    p.$('#dc-del').click();
  }
  assert.equal(p.$('#undo-msg').textContent, 'Deleted Community Meeting #2.');
  await readAgain(p);
  assert.ok(!p.$('#tiles [data-open="m2"]'), 'not back from the Sheet meanwhile');
  await waitFor(() => p.api.done.some(c => c.fn === 'deleteEvent'), 3000, 'the Sheet to be told');
  assert.deepEqual(p.api.sent.filter(c => c.fn === 'deleteEvent').map(c => c.args[1]), ['m2']);
  assert.ok(p.$('#undobar').hidden);
  assert.equal(p.d.activeElement, p.$('#new-ev'), 'focus moves on from the Undo bar');
  assert.equal(evRow(p, 'm2').status, 'deleted');
  assert.equal(evRow(p, 'm2').title, 'OPC Community Meeting', 'the row is still there to read');
  assert.deepEqual(['Bringing', 'Posts', 'Activity'].map(tab => p.g.tab(tab).filter(r => r[0] === 'm2').length), [0, 0, 0]);
  assert.ok(!p.g.ctx.signIn(p.code()).events.some(e => e.cols.id === 'm2'), 'the next read of the Sheet leaves it out');
  // signing out while one waits sends it at once
  p.$(`#tiles [data-open="${id}"]`).click();
  (await waitFor(() => p.$('#detail #delete-ev'), 2000, 'its Delete draft')).click();
  p.$('#dc-del').click();
  p.$('#signout').click();
  assert.ok(p.$('#undobar').hidden && p.shown('#p-landing'));
  assert.deepEqual(p.api.sent.filter(c => c.fn === 'deleteEvent').map(c => c.args[1]), ['m2', id], 'sent before signing out');
  await waitFor(() => p.api.done.filter(c => c.fn === 'deleteEvent').length === 2 && p.idle(), 3000, 'the second delete');
  assert.equal(evRow(p, id).status, 'deleted');
  p.noErrors();
});

test("an event taken out of the Sheet by hand: editing it in an open tab says so, and the Sheet doesn't get it back", async t => {
  const p = await openPage(t);
  await signIn(p, 'Jessie');
  p.$('#tiles [data-open="m2"]').click();
  await waitFor(() => p.$('#detail #edit-ev'), 2000, 'the event to open');
  // its row's id cleared in the Sheet, as /_set does on the dev server
  p.g.sheets.get('Events').set(p.g.tab('Events').findIndex(r => r[0] === 'm2') + 1, 1, '');
  const rows = p.g.tab('Events').length;
  p.$('#edit-ev').click();
  await waitFor(() => p.$('#editf #ed-title'), 2000, 'the edit form');
  p.set('#ed-title', 'Winter planning potluck');
  p.$('#editf button[type=submit]').click();
  const note = "Community Meeting #2 was removed from the Guild Sheet, so your change wasn't saved and it's gone from this page.";
  await waitFor(() => p.api.toasts.includes(note), 3000, 'the note');
  assert.ok(p.$('#modal').hidden, 'its pop-up closes');
  assert.ok(!p.$('#tiles [data-open="m2"]'), 'its tile is gone');
  await sleep(2500); // past the first retry
  assert.equal(p.api.sent.filter(c => c.fn === 'saveEvent').length, 1, 'not tried again');
  assert.equal(p.g.tab('Events').length, rows, 'no row added');
  assert.ok(!p.g.tab('Events').some(r => r[0] === 'm2' || r[2] === 'Winter planning potluck'), 'not added back');
  assert.ok(!p.api.toasts.includes('Saved'), 'never said Saved');
  assert.equal(p.$('#savest').dataset.state, 'idle');
  p.noErrors();
});

test('the prototype artifact cancels and deletes without a server', async t => {
  const p = loadPage(t, ARTIFACT, 'http://localhost/artifact', quickUndo);
  await waitFor(() => p.shown('#p-landing'), 2000, 'the artifact landing page');
  p.$('#signin-top').click();
  p.$('#si-google').click();
  p.$('#new-ev').click();
  assert.deepEqual([p.$('#ed-label').textContent, p.$('#ed-date').value], ['Label: Workday #8', '2026-11-22']);
  p.$('#editf [data-cancel]').click();
  p.$('#tiles [data-open="w7"]').click();
  p.$('#cancel-ev').click();
  p.set('#dc-why', 'Rain');
  p.$('#dconfirm button[type=submit]').click();
  await waitFor(() => p.api.toasts.includes("Cancelled. It's off the public site."), 2000, 'the toast');
  assert.equal(p.$('#detail .dh .evs').textContent, 'Cancelled');
  p.$('#detail [data-dtab="outreach"]').click();
  assert.equal(p.$('#dp-out .osum').textContent.trim(), 'No outreach recorded for this event.', 'its drafts nobody posted are gone');
  p.$('#m-x').click();
  assert.ok(!p.$('#tiles [data-open="w7"]'), 'under Past now');
  p.$('#tiles [data-open="m2"]').click();
  p.$('#delete-ev').click();
  p.$('#dc-del').click();
  assert.equal(p.$('#undo-msg').textContent, 'Deleted Community Meeting #2.');
  await waitFor(() => p.$('#undobar').hidden, 2000, 'the 10 seconds to pass');
  assert.ok(!p.$('#tiles [data-open="m2"]'));
  // signed out, the landing has no Workday #7
  p.$('#signout').click();
  assert.ok(p.shown('#p-landing') && !p.$$('#nextup a.nxcard').some(a => a.dataset.ev === 'w7'));
  assert.deepEqual(p.api.calls, [], 'the artifact calls no server');
  p.noErrors();
});
