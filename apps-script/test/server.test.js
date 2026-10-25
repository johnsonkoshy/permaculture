/* Backend checks against the mock. Run: node --test test/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGas } = require('./gas-mock');

const CODE = 'sprout-4821-bay';
const ev = (over = {}) => ({
  id: 'w7',
  data: { id: 'w7', series: 'workday', photo: 'trellis', tags: ['beginner'], plan: { roles: [['Host', ['Jessie']]], notes: ['Bring gloves'], timeline: [['10:00', 'Garden work', '']] } },
  cols: { label: 'Workday #7', title: 'OPC Garden Work Party', date: '2026-10-25', start: '10:00', end: '14:00', place: 'Oakland Peace Center', address: '111 Fairmount Ave, Oakland', host: 'Jessie', cohosts: 'Phil', about: 'Dig day.', bring: 'water', tags: 'beginner', notes: 'Bring gloves', timeline: '10:00 AM Garden work' },
  tasks: [{ id: 't1', what: 'Plates and cups', who: 'Phil', status: 'asked' }, { id: 't2', what: 'Snacks', who: 'Karen', status: 'confirmed' }, { id: 't3', what: 'Parking sign', who: '', status: 'open' }],
  posts: [{ channel: 'ggroup', status: 'review', by: '', text: 'Subject: Sun 10/25: Work party\n\nHi all,\n\nCome dig.', edited: false }],
  log: [['Oct 11 · 10:00 AM', 'Jessie planned it']],
  ...over,
});
const team = [
  { name: 'Jessie', role: 'lead', contact: 'jessie@example.org', via: 'Email', perms: { create: true, edit: true, approve: true, tasks: true, team: true } },
  { name: 'Phil', role: 'co', contact: 'phil@example.org', via: 'Email', perms: { create: true, edit: true, approve: true, tasks: true, team: false } },
  { name: 'Karen', role: 'vol', contact: '(510) 555-0120', via: 'Text', perms: {} },
];
const seeded = opts => {
  const g = makeGas(opts);
  g.ctx.doGet({ parameter: {} });
  g.ctx.seed(CODE, { events: [ev()], team, vols: [{ name: 'Alex R.', contact: 'alex@example.org', help: ['Garden work days'], note: '', date: '2026-10-18' }], gardens: [{ name: 'OPC garden', addr: '111 Fairmount Ave', what: 'Work days', lat: 37.8136, lng: -122.2589 }] });
  return g;
};

test('first load makes every tab and the settings', () => {
  const g = makeGas();
  const out = g.ctx.doGet({ parameter: { ev: 'w7</script>' } });
  for (const t of ['Events', 'Bringing', 'Posts', 'Team', 'Volunteers', 'Activity', 'Gardens', 'Reminders', 'Settings']) assert.ok(g.sheets.get(t), t);
  assert.ok(!g.sheets.has('Sheet1'), 'blank default tab removed');
  assert.equal(g.tab('Settings').find(r => r[0] === 'TEST_MODE')[1], 'TRUE');
  assert.match(out.content, /window\.EBPG_GAS=/);
  assert.ok(!out.content.includes('w7</script>'), 'deep link is escaped');
  assert.equal(g.ctx.getPublic().events.length, 0);
  g.ctx.doGet({ parameter: {} });
  assert.equal(g.tab('Settings').length, 9, 'settings not duplicated on reload');
  assert.equal(g.tab('Settings').find(r => r[0] === 'SEEDED')[1], '', 'an empty Sheet is not marked as filled');
});

test('organizer code is checked', () => {
  const g = makeGas();
  g.ctx.doGet({});
  assert.throws(() => g.ctx.signIn('nope'), /organizer code/);
  assert.throws(() => g.ctx.saveEvent('', ev()), /organizer code/);
  assert.equal(g.ctx.signIn(CODE).empty, true);
});

test('seed, read back, and the public view hides private bits', () => {
  const g = seeded();
  const st = g.ctx.signIn(CODE);
  assert.equal(st.empty, false);
  const e = st.events[0];
  assert.equal(e.cols.title, 'OPC Garden Work Party');
  assert.equal(e.tasks.length, 3);
  assert.equal(e.posts.ggroup.status, 'review');
  assert.equal(e.log.length, 1);
  assert.equal(st.team.find(t => t.name === 'Phil').perms.approve, true);
  assert.equal(st.team.find(t => t.name === 'Jessie').role, 'lead');
  assert.equal(st.vols[0].help[0], 'Garden work days');
  const pub = g.ctx.getPublic();
  assert.equal(pub.events[0].tasks.length, 0);
  assert.equal(pub.events[0].data.plan.notes.length, 0);
  assert.equal(pub.events[0].cols.notes, '');
  assert.ok(pub.team.every(t => t.contact === '' && t.role !== 'vol'));
  assert.equal(pub.vols, undefined);
  // seeding again does nothing
  g.ctx.seed(CODE, { events: [ev({ id: 'x1', cols: { ...ev().cols, title: 'Other' } })] });
  assert.equal(g.tab('Events').length, 2);
});

test('saving an event updates its rows and leaves other events alone', () => {
  const g = seeded();
  g.ctx.saveEvent(CODE, ev({ id: 'm2', cols: { ...ev().cols, title: 'Meeting', date: '2026-11-12' }, tasks: [{ id: 't9', what: 'Notetaker', who: '', status: 'open' }] }));
  g.ctx.saveEvent(CODE, ev({ cols: { ...ev().cols, title: 'Renamed' }, tasks: [{ id: 't1', what: 'Plates and cups', who: 'Phil', status: 'done' }] }));
  const st = g.ctx.signIn(CODE);
  assert.equal(st.events.length, 2);
  assert.equal(st.events.find(e => e.cols.id === 'w7').cols.title, 'Renamed');
  assert.equal(st.events.find(e => e.cols.id === 'w7').tasks.length, 1);
  assert.equal(st.events.find(e => e.cols.id === 'm2').tasks[0].what, 'Notetaker');
});

test('hand edits in the Sheet are read back, including typed dates and times', () => {
  const g = seeded();
  const sh = g.sheets.get('Events');
  sh.set(2, 4, '10/31/2026'); sh.set(2, 5, '9:30 AM'); sh.set(2, 6, '2:00:00 PM');
  sh.set(3, 1, ''); // a stray blank row in the middle is fine
  const e = g.ctx.signIn(CODE).events[0];
  assert.equal(e.cols.date, '2026-10-31');
  assert.equal(e.cols.start, '09:30');
  assert.equal(e.cols.end, '14:00');
});

test('values that look like formulas are stored as text', () => {
  const g = seeded();
  g.ctx.addVolunteer({ name: '=IMPORTXML("x")', contact: '+1 510 555 0000', help: ['@everyone'], note: '-1' });
  const row = g.sheets.get('Volunteers').cells[2];
  assert.equal(row[1], "'=IMPORTXML(\"x\")");
  assert.equal(row[2], "'+1 510 555 0000");
  assert.equal(g.tab('Volunteers')[2][1], '=IMPORTXML("x")', 'shows normally');
});

test('volunteer sign-up: row, welcome email and lead alert, all to the owner in test mode', () => {
  const g = seeded();
  assert.throws(() => g.ctx.addVolunteer({ name: '', contact: 'x' }), /name/);
  g.ctx.addVolunteer({ name: 'Sam Lee', contact: 'sam@example.org', help: ['Garden work days'], note: 'Has a truck', date: 'ignored' });
  assert.equal(g.tab('Volunteers').length, 3);
  assert.equal(g.mail.length, 2);
  assert.ok(g.mail.every(m => m.to === 'owner@example.com'));
  assert.match(g.mail[0].subject, /^\[TEST to sam@example\.org\] Welcome/);
  assert.match(g.mail[1].subject, /^\[TEST to jessie@example\.org\] New volunteer: Sam Lee/);
});

test('posting: Google Group email and calendar event', () => {
  const g = seeded();
  assert.match(g.ctx.postTo(CODE, 'w7', 'ggroup', ev().posts[0].text), /Test mode/);
  assert.equal(g.mail[0].subject, '[TEST to the Google Group] Sun 10/25: Work party');
  assert.match(g.mail[0].body, /^Hi all/);
  g.ctx.postTo(CODE, 'w7', 'calendar', 'See you there');
  assert.equal(g.calendar[0].title, 'OPC Garden Work Party');
  assert.equal(g.calendar[0].start.toISOString(), '2026-10-25T17:00:00.000Z', '10 AM Pacific');
  assert.match(g.calendar[0].location, /Oakland Peace Center, 111 Fairmount/);
  assert.throws(() => g.ctx.postTo(CODE, 'w7', 'partiful', 'x'), /copy and paste/);
  assert.throws(() => g.ctx.postTo(CODE, 'nope', 'ggroup', 'x'), /Save the event/);
  // live mode needs the group address
  const s = g.sheets.get('Settings'), row = g.tab('Settings').findIndex(r => r[0] === 'TEST_MODE') + 1;
  s.set(row, 2, 'FALSE');
  assert.throws(() => g.ctx.postTo(CODE, 'w7', 'ggroup', 'x'), /Google Group address/);
});

test('reminders: evening before, once only, phone-only people go to the host as a list', () => {
  const g = seeded({ now: '2026-10-24T19:30:00-07:00' }); // Sat 7:30 PM, event is Sun
  assert.equal(g.ctx.hourly(), 2);
  const subjects = g.mail.map(m => m.subject);
  assert.ok(subjects.some(s => /\[TEST to phil@example\.org\] Reminder: Plates and cups/.test(s)), subjects.join(' | '));
  assert.ok(subjects.some(s => /Text these people/.test(s)));
  assert.match(g.mail.find(m => /Text these/.test(m.subject)).body, /Karen \(\(510\) 555-0120\): Snacks/);
  assert.equal(g.ctx.hourly(), 0, 'no repeats');
  g.clock.now = new Date('2026-10-25T08:30:00-07:00').getTime();
  assert.equal(g.ctx.hourly(), 2, 'morning-of round');
  g.clock.now = new Date('2026-10-25T13:00:00-07:00').getTime();
  assert.equal(g.ctx.hourly(), 0, 'nothing in the afternoon');
});

test('gardens added by hand get map coordinates', () => {
  const g = seeded();
  g.sheets.get('Gardens').set(3, 1, 'Dimond Park'); g.sheets.get('Gardens').set(3, 2, '3860 Hanly Rd, Oakland');
  const pub = g.ctx.getPublic();
  assert.equal(pub.gardens.length, 2);
  assert.equal(pub.gardens[1].lat, 37.81);
});

test('JSON API: only the page functions are callable, errors come back as JSON', () => {
  const g = seeded();
  const call = (fn, args) => JSON.parse(g.ctx.doPost({ postData: { contents: JSON.stringify({ fn, args }) } }).content);
  assert.equal(call('signIn', [CODE]).value.events.length, 1);
  assert.match(call('signIn', ['nope']).error, /organizer code/);
  for (const fn of ['hourly', 'setup', 'ensure_', 'mail_', 'toString', '__proto__', 'constructor']) assert.match(call(fn, []).error, /Unknown call/, fn);
  assert.match(JSON.parse(g.ctx.doPost({ postData: { contents: 'not json' } }).content).error, /JSON|Unexpected/);
  assert.equal(call('getPublic').value.events.length, 1, 'missing args is fine');
});

test('SITE_URL sends the old Google link to Netlify, keeping event links', () => {
  const g = seeded();
  const s = g.sheets.get('Settings'), row = g.tab('Settings').findIndex(r => r[0] === 'SITE_URL') + 1;
  s.set(row, 2, 'https://ebpg.netlify.app/');
  const out = g.ctx.doGet({ parameter: { ev: 'w7' } }).content;
  assert.match(out, /href="https:\/\/ebpg\.netlify\.app\/\?ev=w7"/);
  assert.ok(!/<script>[^<]*\/\//.test(out), 'no // inside the redirect script');
  s.set(row, 2, 'javascript:alert(1)');
  assert.match(g.ctx.doGet({ parameter: {} }).content, /EBPG_GAS/, 'bad SITE_URL is ignored');
});

/* ---------- starter data: filled once, and a reset for the editor ---------- */
const clearRows = (g, name) => { const sh = g.sheets.get(name); for (let r = 2; r <= sh.cells.length; r++) (sh.cells[r - 1] || []).fill(''); };
const setting = (g, k) => (g.tab('Settings').find(r => r[0] === k) || [])[1];

test('the first sign-in fills the Sheet once; an Events tab emptied later is not refilled', () => {
  const g = seeded();
  assert.equal(setting(g, 'SEEDED'), 'TRUE', 'seed marks the Sheet as filled');
  clearRows(g, 'Events');
  assert.equal(g.ctx.signIn(CODE).events.length, 0);
  assert.equal(g.ctx.signIn(CODE).empty, false, 'no re-seed');
  g.ctx.seed(CODE, { events: [ev()], team, vols: [], gardens: [] });
  assert.equal(g.tab('Events').length, 1, 'seed refuses to run again');
});

test('seed with no volunteers leaves the Volunteers tab empty', () => {
  const g = makeGas();
  g.ctx.doGet({});
  g.ctx.seed(CODE, { events: [ev()], team, vols: [], gardens: [] });
  assert.equal(g.tab('Volunteers').length, 1, 'only the header row');
  assert.equal(g.ctx.signIn(CODE).vols.length, 0);
});

test('resetStarterData empties the data tabs, keeps headers and settings, and the next sign-in refills', () => {
  const g = seeded();
  g.ctx.addVolunteer({ name: 'Sam Lee', contact: 'sam@example.org', help: [], note: '' });
  g.ctx.saveEvent(CODE, ev({ log: [['Oct 24', 'Jessie edited the event']] }));
  assert.match(g.ctx.resetStarterData(), /^Cleared\. The next organizer sign-in fills the Sheet/);
  for (const t of ['Events', 'Bringing', 'Posts', 'Activity', 'Volunteers', 'Reminders', 'Team', 'Gardens']) {
    assert.equal(g.tab(t).length, 1, t + ' has only its header row');
    assert.ok(g.tab(t)[0][0], t + ' header kept');
  }
  assert.equal(g.tab('Events')[0][0], 'id');
  assert.equal(setting(g, 'SEEDED'), '');
  assert.equal(setting(g, 'ORGANIZER_CODE'), CODE, 'settings are kept');
  const st = g.ctx.signIn(CODE);
  assert.equal(st.empty, true);
  g.ctx.seed(CODE, { events: [ev()], team, vols: [], gardens: [] });
  assert.equal(g.tab('Events').length, 2, 'refilled');
  assert.equal(g.tab('Team').length, team.length + 1, 'team refilled');
  assert.equal(g.ctx.signIn(CODE).empty, false);
});

test('resetStarterData runs only from the editor, never from the page', () => {
  const g = seeded({ activeUser: '' }); // an anonymous visitor of the web app
  assert.throws(() => g.ctx.resetStarterData(), /script editor/);
  assert.equal(g.tab('Events').length, 2, 'nothing cleared');
  const call = fn => JSON.parse(g.ctx.doPost({ postData: { contents: JSON.stringify({ fn, args: [] }) } }).content);
  assert.match(call('resetStarterData').error, /Unknown call/);
});

test('a Sheet filled before SEEDED existed is marked filled on the next load', () => {
  const g = seeded();
  const s = g.sheets.get('Settings'), row = g.tab('Settings').findIndex(r => r[0] === 'SEEDED') + 1;
  s.cells[row - 1] = ['', '', '']; // an older Sheet: no SEEDED row yet
  g.ctx.doGet({});
  assert.equal(setting(g, 'SEEDED'), 'TRUE');
  clearRows(g, 'Events');
  assert.equal(g.ctx.signIn(CODE).empty, false);
});

test('an update that adds a column labels it in an older Sheet', () => {
  const g = seeded();
  g.sheets.get('Bringing').set(1, 6, ''); // a Bringing tab made before 'last time' existed
  const s = g.sheets.get('Settings'), row = g.tab('Settings').findIndex(r => r[0] === 'SEEDED') + 1;
  s.cells[row - 1] = ['', '', ''];
  g.ctx.doGet({});
  assert.deepEqual(g.tab('Bringing')[0], ['event id', 'what', 'who', 'status', 'task id', 'last time']);
  assert.equal(g.tab('Bringing')[1][1], 'Plates and cups', 'data not moved');
});

test("copied tasks keep who did them last time; blank contacts aren't given a reminder method", () => {
  const g = makeGas();
  g.ctx.doGet({});
  g.ctx.seed(CODE, {
    events: [ev({ tasks: [{ id: 't1', what: 'Plates and cups', who: '', status: 'open', last: 'Phil' }] })],
    team: [{ name: 'Jessie', role: 'lead', contact: '', via: '', perms: {} }, { name: 'Phil', role: 'co', contact: '', via: '', perms: { approve: true } }],
    vols: [], gardens: [],
  });
  const st = g.ctx.signIn(CODE);
  assert.deepEqual(JSON.parse(JSON.stringify(st.events[0].tasks[0])), { what: 'Plates and cups', who: '', status: 'open', id: 't1', last: 'Phil' });
  assert.equal(g.tab('Bringing')[1][5], 'Phil', "in the Sheet's 'last time' column");
  assert.ok(st.team.every(t => t.contact === '' && t.via === ''));
});

test('reminders: nothing goes out for an open, unassigned task', () => {
  const g = makeGas({ now: '2026-10-24T19:00:00-07:00' }); // Sat 7 PM, the event is Sun
  g.ctx.doGet({});
  g.ctx.seed(CODE, { events: [ev({ tasks: [{ id: 't1', what: 'Make a parking sign', who: '', status: 'open', last: '' }, { id: 't2', what: 'Plates and cups', who: '', status: 'open', last: 'Phil' }] })], team, vols: [], gardens: [] });
  assert.equal(g.ctx.hourly(), 0);
  assert.equal(g.mail.length, 0);
});

/* ---------- live page: the Help page's Sheet link and the friendly error bar ---------- */
test("signIn gives organizers the Sheet's link for the Help page; the public view doesn't", () => {
  const g = seeded();
  assert.equal(g.ctx.signIn(CODE).sheetUrl, 'https://docs.google.com/spreadsheets/d/sheet-1/edit');
  assert.ok(!JSON.stringify(g.ctx.getPublic()).includes('docs.google.com'), 'not in getPublic');
  const call = (fn, args) => JSON.parse(g.ctx.doPost({ postData: { contents: JSON.stringify({ fn, args }) } }).content);
  assert.equal(call('signIn', [CODE]).value.sheetUrl, 'https://docs.google.com/spreadsheets/d/sheet-1/edit', 'and through the JSON API');
  assert.equal(call('signIn', ['nope']).value, undefined, 'not without the code');
});

test('the Google-hosted page shows a friendly error bar, with no "//" in its script', () => {
  const vm = require('vm');
  const out = makeGas().ctx.doGet({ parameter: {} }).content;
  const js = out.match(/^<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(!js.includes('//'), 'HtmlService would cut the line at //');
  assert.ok(js.includes('Something went wrong. Please refresh the page. If it keeps happening, email the Guild.'));
  assert.ok(js.includes("b.textContent='Dismiss'"));
  assert.ok(!/Something broke|e\.message\+|monospace/.test(js), 'no raw message on the page');
  assert.ok(/console\.error\(/.test(js), 'details go to the console');
  new vm.Script(js);
});
