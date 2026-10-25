/* Headless smoke test of the real Netlify page (site/index.html) against the mock backend.
   Each test loads the page fresh in jsdom with a fresh mock Sheet, so no browser is needed.
   Build first: python3 build.py   Run: node --test test/   (or node --test test/smoke.test.js)

   What the page gets that jsdom lacks: every POST goes to Code.js doPost on the mock, and
   scrollTo, matchMedia, the observers, the clipboard, canvas and window.open are stubbed.
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
  const api = { errors: [], calls: [], sent: [], done: [], out: {}, most: {}, latency: 0, fail: '', pending: 0, copied: [], opened: [], toasts: [] };
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

/* type the code and pick an organizer (the first one unless named); returns the name picked */
async function startSignIn(p, code, who) {
  p.$('#signin-top').click();
  await waitFor(() => p.shown('#p-signin'), 2000, 'the sign-in page');
  assert.ok(p.shown('#si-codew') && p.visible('#si-codew'), 'the organizer code field is shown');
  p.set('#si-code', code);
  const pick = await waitFor(() => p.$(who ? `#si-pick button[data-as="${who}"]` : '#si-pick button[data-as]'), 2000, 'an organizer to pick');
  pick.click();
  return pick.dataset.as;
}
async function signIn(p, who) {
  const name = await startSignIn(p, p.code(), who);
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out') && p.$('#tiles [data-open]'), 4000, 'the events page after sign-in');
  await waitFor(p.idle, 2000, 'sign-in calls to finish');
  return name;
}

test('the built page exists', () => assert.ok(fs.existsSync(SITE), MISSING));

test('landing page renders with upcoming events', async t => {
  const p = await openPage(t);
  assert.ok(p.shown('#p-landing'), 'landing page is visible');
  assert.ok(!p.shown('#p-events'), 'organizer pages stay hidden');
  assert.ok(p.d.body.classList.contains('out'), 'signed out');
  const cards = p.$$('#nextup > *');
  assert.ok(cards.length >= 1, 'at least one upcoming event card');
  assert.ok(cards.every(c => c.textContent.trim()), 'cards have text');
  assert.ok(p.$$('#nextup button').length >= 1, 'at least one upcoming Guild event from the event list');
  assert.ok(p.$$('#si-pick button[data-as]').length >= 1, 'organizers to sign in as');
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
  const p = await openPage(t);
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
  assert.deepEqual(p.$$('.tabs a').filter(p.visible).map(a => a.textContent), ['Events', 'Team', 'Templates', 'Help']);
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
const ICONS = ['x', 'arrow-left', 'arrow-down', 'log-in', 'log-out', 'calendar', 'calendar-plus', 'clock', 'map-pin', 'users', 'user-plus', 'user-minus', 'user-check',
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
  const p = await openPage(t);
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
  assert.ok(p.$$('#nextup button .meta use[href="#i-calendar"]').length >= 1 && p.$$('#nextup button .meta use[href="#i-map-pin"]').length >= 1, 'when and where on the event cards');
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
  assert.deepEqual(p.$$('.tabs a').filter(p.visible).map(a => a.textContent), ['Events', 'Team', 'Templates', "How we'd build it"]);
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
  const p = await openPage(t);
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
  const p = await openPage(t);
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
  // the public read is still out when the name is picked, and comes back before the sign-in does
  const p = loadPage(t, SITE, 'http://localhost:8766/site', (w, g, api) => { g.ctx.getPublic(); api.latency = 300; });
  p.api.latency = 1500;
  p.$('#signin-top').click();
  p.set('#si-code', p.code());
  const pick = p.$('#si-pick button[data-as="Jessie"]');
  pick.focus();
  pick.click();
  assert.equal(pick.getAttribute('aria-busy'), 'true');
  p.api.latency = 500; // for the seed that follows
  await waitFor(() => !pick.isConnected, 3000, 'the picker to be redrawn with what the Sheet has');
  assert.ok(!p.api.done.some(c => c.fn === 'signIn'), 'the sign-in is still going');
  const btn = p.$('#si-pick button[data-as="Jessie"]');
  assert.equal(btn.getAttribute('aria-busy'), 'true', 'the redrawn name is still busy');
  assert.match(btn.textContent, /Jessie\s*Signing in…$/);
  assert.ok(!btn.disabled && p.d.activeElement === btn, 'and keeps keyboard focus');
  assert.ok(p.$$('#si-pick button').filter(b => b !== btn).every(b => b.disabled), 'the other names still wait');
  assert.equal(p.$('#si-wait').textContent, 'Waking up the Guild Sheet. This can take a few seconds.');
  btn.click(); // still does nothing while it works
  // an empty Sheet gets filled first, and the line says so
  await waitFor(() => p.api.out.seed === 1, 3000, 'the Sheet to be filled');
  assert.equal(p.$('#si-wait').textContent, 'Setting up the Guild Sheet for the first time. This can take up to a minute.');
  await waitFor(() => p.shown('#p-events') && !p.d.body.classList.contains('out'), 4000, 'the events page');
  await waitFor(p.idle, 2000, 'calls to finish');
  assert.equal(p.api.calls.filter(c => c === 'signIn').length, 1, 'one sign-in call');
  assert.ok(p.$$('#si-pick button').every(b => !b.disabled && !b.hasAttribute('aria-busy')), 'the names are back to normal');
  assert.ok(!p.$$('#si-pick small').some(s => /Signing in/.test(s.textContent)));
  assert.equal(p.$('#si-wait').textContent, '');
  p.noErrors();
});

test('a remembered device stays remembered when signing back in fails and the name is picked again', async t => {
  const p = loadPage(t, SITE, 'http://localhost:8766/site', (w, g, api) => { withCode('device', 'Kalynn', 864e5)(w, g, api); api.fail = 'signIn'; });
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
    cols: { label: 'Workday #9', title: 'OPC Garden Work Party', date: '2026-10-31', start: '10:00', end: '14:00', place: 'Oakland Peace Center', address: '', host: 'Jessie', cohosts: '', about: 'Dig day.', bring: 'water', tags: 'beginner', notes: '', timeline: '' },
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
  });
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
