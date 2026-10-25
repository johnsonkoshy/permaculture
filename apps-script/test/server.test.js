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
  assert.equal(g.tab('Settings').length, 8, 'settings not duplicated on reload');
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
