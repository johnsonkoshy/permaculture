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
const FAILED = /\bcouldn['’]t\b|no connection/i; // how the page words a failed call in its toast

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
    let fn = '?';
    try { fn = JSON.parse(body).fn; } catch {}
    api.calls.push(fn); api.pending++;
    return new w.Promise(resolve => w.setTimeout(() => {
      g.clock.now = w.Date.now();
      const out = g.ctx.doPost({ postData: { contents: body } });
      api.pending--;
      resolve({ ok: true, status: 200, json: async () => w.JSON.parse(out.content), text: async () => out.content });
    }, 0));
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

/* load a page in a fresh jsdom with a fresh mock Sheet */
function loadPage(t, file, url) {
  const g = makeGas({ page: undefined, now: START });
  const api = { errors: [], calls: [], pending: 0, copied: [], opened: [], toasts: [] };
  const vc = new VirtualConsole();
  vc.on('error', (...a) => api.errors.push('console.error: ' + a.map(x => (x && x.stack) || String(x)).join(' ')));
  vc.on('jsdomError', e => { if (!NOISE.test(e.message)) api.errors.push('jsdom: ' + ((e.detail && e.detail.stack) || e.stack || e.message)); });
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    runScripts: 'dangerously', pretendToBeVisual: true, url, virtualConsole: vc,
    beforeParse: w => stub(w, g, api),
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
async function openPage(t) {
  assert.ok(fs.existsSync(SITE), MISSING);
  const p = loadPage(t, SITE, 'http://localhost:8766/site');
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
  assert.equal(p.api.toasts.at(-1), 'Saved');
  const row = () => p.g.tab('Events').find(r => r[0] === id);
  assert.notEqual(row()[2], title, 'not saved before the debounce');
  await waitFor(() => row()[2] === title, 3000, 'the new title in the Events tab');
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
  assert.deepEqual(seen.filter(el => el.tagName === 'INPUT').map(el => el.id), ['si-code']);
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
  for (const s of ['ORGANIZER_CODE', 'Settings', 'TEST_MODE', 'goes only to the Sheet', '6 PM the evening before', 'between 8 AM and noon on the day', 'shows up here the next time the page loads'])
    assert.ok(help.includes(s), s);
  assert.match(p.$('#help-lead').textContent, /^Jessie is the lead organizer\. Ask Jessie/);

  // signing out hides the chip; a co-organizer missing two permissions gets both in plain words
  p.$('#signout').click();
  assert.ok(p.d.body.classList.contains('out') && !p.visible('#who') && !p.visible('#p-help'), 'signed out');
  await signIn(p, 'Kalynn');
  assert.equal(p.$('#who > span:last-child').textContent, 'Signed in as Kalynn · Co-organizer');
  p.$('#tiles [data-open]').click();
  assert.equal((await waitFor(() => p.$('#detail #perm-note'), 2000, 'the permissions note')).textContent, "You can't post or manage the team. Ask Jessie if you need to.");
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
  assert.ok(p.$$('#dp-out [data-act=post]').every(b => b.querySelector('use[href="#i-copy"], use[href="#i-send"]')), 'post buttons say copy or send');
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
  assert.equal(toast.textContent, 'Sam <b>Lee</b> added as volunteer');
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
  p.$('#dp-out [data-act=post][data-ch=ggroup]').click();
  await waitFor(() => p.api.toasts.includes('Posted to Google Group email (simulated)'), 2000, 'the simulated post');
  p.$('#m-x').click();

  p.set('#as', 'Kalynn');
  await waitFor(() => p.api.toasts.includes('Viewing as Kalynn'), 2000, 'the Viewing as toast');
  p.$('#tiles [data-open="w7"]').click();
  assert.equal(p.$('#detail #perm-note').textContent, "You can't post or manage the team. Ask Jessie if you need to.");
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
