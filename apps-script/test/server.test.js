/* Backend checks against the mock. Run: node --test test/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGas } = require('./gas-mock');

// The Settings tab starts with a blank code, so these tests set one in the mock Settings themselves.
const CODE = 'garden-test-2468';
const gas = (opts = {}) => makeGas({ settings: { ORGANIZER_CODE: CODE }, ...opts });
const ev = (over = {}) => ({
  id: 'w7',
  data: { id: 'w7', series: 'workday', photo: 'trellis', tags: ['beginner'], plan: { roles: [['Host', ['Jessie']]], notes: ['Bring gloves'], timeline: [['10:00', 'Garden work', '']] } },
  cols: { label: 'Workday #7', title: 'OPC Garden Work Party', date: '2026-10-25', start: '10:00', end: '14:00', place: 'Oakland Peace Center', address: '111 Fairmount Ave, Oakland', host: 'Jessie', cohosts: 'Phil', about: 'Dig day.', bring: 'water', tags: 'beginner', notes: 'Bring gloves', timeline: '10:00 AM Garden work', status: 'published', rsvp: '' },
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
  const g = gas(opts);
  g.ctx.doGet({ parameter: {} });
  g.ctx.seed(CODE, { events: [ev()], team, vols: [{ name: 'Alex R.', contact: 'alex@example.org', help: ['Garden work days'], note: '', date: '2026-10-18' }], gardens: [{ name: 'OPC garden', addr: '111 Fairmount Ave', what: 'Work days', lat: 37.8136, lng: -122.2589 }] });
  return g;
};
/* posting: the event as the page sends it, with the Google Group and Calendar posts approved */
const GROUP_TEXT = 'Subject: Sun 10/25: Work party\n\nHi all,\n\nCome dig.';
const approved = (channel, text) => ({ channel, status: 'approved', by: '', text, edited: false, approvedBy: 'Phil', approvedAt: '2026-10-24T18:00:00.000Z', at: '', url: '' });
const toPost = (over = {}) => ev({ posts: [approved('ggroup', GROUP_TEXT), approved('calendar', 'OPC Garden Work Party\nSee you there')], ...over });
const postRowOf = (g, id, ch) => { const [head, ...rows] = g.tab('Posts'), r = rows.find(x => x[0] === id && x[1] === ch); return r && Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : r[i]])); };
const ISO = /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
// the morning before the fixture's event (Sun Oct 25), so it's still upcoming whatever day the tests run
const BEFORE = '2026-10-24T10:00:00-07:00';

test('first load makes every tab and the settings', () => {
  const g = gas();
  const out = g.ctx.doGet({ parameter: { ev: 'w7</script>' } });
  for (const t of ['Events', 'Bringing', 'Posts', 'Team', 'Volunteers', 'Activity', 'Gardens', 'Reminders', 'Channels', 'Settings']) assert.ok(g.sheets.get(t), t);
  assert.ok(!g.sheets.has('Sheet1'), 'blank default tab removed');
  assert.equal(g.tab('Settings').find(r => r[0] === 'TEST_MODE')[1], 'TRUE');
  assert.match(out.content, /window\.EBPG_GAS=/);
  assert.ok(!out.content.includes('w7</script>'), 'deep link is escaped');
  assert.equal(g.ctx.getPublic().events.length, 0);
  g.ctx.doGet({ parameter: {} });
  assert.equal(g.tab('Settings').length, 15, 'settings not duplicated on reload');
  assert.deepEqual(['SCHEDULE_TEXT', 'WORKDAY_SCHEDULE', 'LINKTREE_URL', 'CONTACT_EMAIL'].map(k => g.tab('Settings').find(r => r[0] === k)[1]), [
    'Garden work days at the Oakland Peace Center, plus community meetings with a potluck. Everyone is welcome, no experience needed.',
    '4th Sundays, 10 AM', 'https://linktr.ee/eastbaypermacultureguild', '']);
  assert.deepEqual(g.tab('Events')[0].slice(-3), ["data (don't edit)", 'status', 'rsvp link']);
  assert.equal(g.tab('Settings').find(r => r[0] === 'SEEDED')[1], '', 'an empty Sheet is not marked as filled');
});

test('organizer code is checked', () => {
  const g = gas();
  g.ctx.doGet({});
  assert.throws(() => g.ctx.signIn('nope'), /organizer code/);
  assert.throws(() => g.ctx.saveEvent('', ev()), /organizer code/);
  assert.equal(g.ctx.signIn(CODE).empty, true);
});

test('seed, read back, and the public view hides private bits', () => {
  const g = seeded({ now: BEFORE });
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
  const pub = plain(g.ctx.getPublic());
  assert.deepEqual(Object.keys(pub), ['events', 'cancelled', 'team', 'gardens', 'settings']);
  assert.equal(pub.events.length, 1);
  for (const k of ['tasks', 'posts', 'log', 'plan', 'notes', 'data', 'cols']) assert.equal(pub.events[0][k], undefined, k);
  assert.deepEqual(pub.team, [{ name: 'Jessie', role: 'lead' }, { name: 'Phil', role: 'co' }], 'organizers only, names and roles');
  assert.equal(pub.vols, undefined);
  // seeding again does nothing
  g.ctx.seed(CODE, { events: [ev({ id: 'x1', cols: { ...ev().cols, title: 'Other' } })] });
  assert.equal(g.tab('Events').length, 2);
});

test('saving an event updates its rows and leaves other events alone', () => {
  const g = seeded();
  g.ctx.saveEvent(CODE, ev({ id: 'm2', created: true, cols: { ...ev().cols, title: 'Meeting', date: '2026-11-12' }, tasks: [{ id: 't9', what: 'Notetaker', who: '', status: 'open' }] }));
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
  g.ctx.addVolunteer({ name: 'Sam Lee', phone: '+1 510 555 0000', help: ['Garden work days'], note: '=IMPORTXML("x")' });
  const row = g.sheets.get('Volunteers').cells[2];
  assert.equal(row[4], "'=IMPORTXML(\"x\")");
  assert.equal(row[2], "'+1 510 555 0000");
  assert.equal(g.tab('Volunteers')[2][4], '=IMPORTXML("x")', 'shows normally');
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

test('posting in test mode: the Group email and a [TEST] calendar entry go to the owner, and the Posts rows say Test sent', () => {
  const g = seeded();
  const out = g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' });
  assert.equal(out.message, 'Test sent. Test mode is on, so the Google Group email went only to owner@example.com.');
  assert.equal(g.mail.length, 1);
  assert.equal(g.mail[0].to, 'owner@example.com');
  assert.equal(g.mail[0].subject, '[TEST to the Google Group] Sun 10/25: Work party');
  assert.match(g.mail[0].body, /^Hi all/);
  const row = postRowOf(g, 'w7', 'ggroup');
  assert.deepEqual([row.status, row['posted by'], row['approved by'], row['calendar id'], row.stale], ['test', 'Phil', 'Phil', '', '']);
  assert.match(row['posted at'], ISO);
  // the answer is the event as signIn reads it, with the new row and Activity line
  const e = plain(out.event);
  assert.equal(e.cols.id, 'w7');
  assert.deepEqual([e.posts.ggroup.status, e.posts.ggroup.by, e.posts.ggroup.at, e.posts.ggroup.stale], ['test', 'Phil', row['posted at'], false]);
  assert.equal(e.posts.calendar.status, 'approved');
  assert.equal(e.log.at(-1)[1], 'Phil posted to the Google Group (test mode: only the Sheet owner got it)');
  assert.match(e.log.at(-1)[0], /^Oct \d{1,2} \u00b7 \d{1,2}:\d\d [AP]M$/, 'the same time format as the page');
  assert.deepEqual(g.tab('Activity').at(-1), ['w7', e.log.at(-1)[0], e.log.at(-1)[1]]);

  const cal = g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil' });
  assert.equal(cal.message, "Test sent. Test mode is on, so it went on the Sheet owner's calendar, marked [TEST].");
  assert.equal(g.calendar.length, 1);
  const c = g.calendar[0];
  assert.deepEqual([c.cal, c.title, c.location, c.description], ['default', '[TEST] OPC Garden Work Party', 'Oakland Peace Center, 111 Fairmount Ave, Oakland', 'OPC Garden Work Party\nSee you there']);
  assert.equal(c.start.toISOString(), '2026-10-25T17:00:00.000Z', '10 AM Pacific');
  assert.equal(c.end.toISOString(), '2026-10-25T21:00:00.000Z', '2 PM Pacific');
  assert.deepEqual([postRowOf(g, 'w7', 'calendar').status, postRowOf(g, 'w7', 'calendar')['calendar id']], ['test', c.id]);
  assert.equal(plain(cal.event).posts.ggroup.status, 'test', 'the Group row is still sent');
  assert.equal(plain(cal.event).log.at(-1)[1], "Phil posted to the Calendar (test mode: on the Sheet owner's calendar)");
  assert.equal(g.mail.length, 1, 'no email for the calendar');
});

test('posting live: the Google Group gets the email, the Guild calendar the entry, and the rows say posted', () => {
  const g = seeded();
  setSetting(g, 'TEST_MODE', 'FALSE');
  assert.throws(() => g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' }), /Add the Google Group address on the Settings tab first/);
  assert.equal(postRowOf(g, 'w7', 'ggroup').status, 'approved', 'not marked as sent');
  assert.equal(g.mail.length, 0);
  setSetting(g, 'GROUP_EMAIL', 'ebpg@googlegroups.com');
  setSetting(g, 'CALENDAR_ID', 'guild@group.calendar.google.com');
  assert.equal(g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' }).message, 'Emailed the Google Group.');
  assert.deepEqual([g.mail[0].to, g.mail[0].subject], ['ebpg@googlegroups.com', 'Sun 10/25: Work party']);
  assert.equal(postRowOf(g, 'w7', 'ggroup').status, 'posted');
  const out = g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil' });
  assert.equal(out.message, 'Added to Guild calendar.');
  assert.deepEqual([g.calendar.length, g.calendar[0].cal, g.calendar[0].title], [1, 'guild@group.calendar.google.com', 'OPC Garden Work Party']);
  assert.deepEqual([postRowOf(g, 'w7', 'calendar').status, postRowOf(g, 'w7', 'calendar')['calendar id']], ['posted', g.calendar[0].id]);
  assert.equal(plain(out.event).log.at(-1)[1], 'Phil posted to the Calendar');
});

test('postTo saves the event first: a brand-new event posts with no saveEvent before it, using its current title', () => {
  const g = seeded();
  const fresh = ev({ id: 'n1729', created: true, data: { id: 'n1729', photo: 'none', tags: [], plan: { roles: [['Host', ['Phil']]], notes: [], timeline: [] } },
    cols: { ...ev().cols, label: '', title: 'Seed swap', date: '2026-10-31', start: '11:00', end: '13:00' }, tasks: [], log: [['Oct 24 · 9:00 AM', 'Phil created the event']],
    posts: [approved('ggroup', 'Hi all,\n\nBring seeds to share.')] });
  const out = g.ctx.postTo(CODE, fresh, 'ggroup', { by: 'Phil' });
  assert.equal(g.tab('Events').filter(r => r[0] === 'n1729').length, 1, 'the event is on the Events tab');
  assert.equal(g.tab('Events').find(r => r[0] === 'n1729')[2], 'Seed swap');
  assert.equal(g.mail.length, 1);
  assert.equal(g.mail[0].subject, '[TEST to the Google Group] Seed swap, Saturday, October 31', 'a subject from the title and date as sent');
  assert.equal(g.mail[0].body, 'Hi all,\n\nBring seeds to share.');
  assert.deepEqual(plain(out.event.log).map(l => l[1]), ['Phil created the event', 'Phil posted to the Google Group (test mode: only the Sheet owner got it)']);
  // and the time posted is the one sent, not an older saved one
  g.ctx.postTo(CODE, { ...fresh, cols: { ...fresh.cols, start: '12:30' }, posts: [approved('calendar', 'Seed swap')] }, 'calendar', { by: 'Phil' });
  assert.equal(g.calendar[0].start.toISOString(), '2026-10-31T19:30:00.000Z', '12:30 PM Pacific');
});

test('postTo needs an approved post, refuses a second send unless forced, and copy channels are copy and paste', () => {
  const g = seeded();
  assert.throws(() => g.ctx.postTo(CODE, toPost({ posts: [{ ...approved('ggroup', GROUP_TEXT), status: 'review', approvedBy: '', approvedAt: '' }] }), 'ggroup', { by: 'Phil' }), /^Error: Approve it first\.$/);
  assert.equal(postRowOf(g, 'w7', 'ggroup').status, 'review', 'the draft saved as it was');
  assert.throws(() => g.ctx.postTo(CODE, ev({ posts: [] }), 'calendar', { by: 'Phil' }), /Approve it first/, 'a channel the event does not use');
  assert.equal(g.mail.length + g.calendar.length, 0, 'nothing sent');
  assert.throws(() => g.ctx.postTo(CODE, toPost(), 'partiful', { by: 'Phil' }), /copy and paste/);
  assert.throws(() => g.ctx.postTo('wrong-code-1', toPost(), 'ggroup', { by: 'Phil' }), /organizer code/);

  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' });
  // a second press, or a tab that still says approved: no second email
  assert.throws(() => g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Jessie' }), /^Error: Already posted\./);
  assert.equal(g.mail.length, 1);
  assert.equal(postRowOf(g, 'w7', 'ggroup')['posted by'], 'Phil', 'still the first post');
  // force is Post for real: not while test mode is still on
  assert.throws(() => g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Jessie', force: true }), /^Error: Already posted\. To tell the Group about a change, use Draft an update\.$/);
  assert.equal(g.mail.length, 1);
  // once test mode is off it sends the test again, for real; a name that's too long is cut to 60 characters
  setSetting(g, 'TEST_MODE', 'FALSE');
  setSetting(g, 'GROUP_EMAIL', 'ebpg@googlegroups.com');
  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: '  ' + 'P'.repeat(90), force: true });
  assert.equal(g.mail.length, 2);
  assert.deepEqual([postRowOf(g, 'w7', 'ggroup').status, postRowOf(g, 'w7', 'ggroup')['posted by']], ['posted', 'P'.repeat(60)]);
});

test('Post for real goes out once: a second tab, or a press again after no answer, sends the Group nothing more', () => {
  const g = seeded();
  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' });
  assert.equal(postRowOf(g, 'w7', 'ggroup').status, 'test');
  setSetting(g, 'TEST_MODE', 'FALSE');
  setSetting(g, 'GROUP_EMAIL', 'ebpg@googlegroups.com');
  // tab A presses Post for real
  assert.equal(g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil', force: true }).message, 'Emailed the Google Group.');
  const at = postRowOf(g, 'w7', 'ggroup')['posted at'];
  assert.equal(g.tab('Activity').at(-1)[2], 'Phil posted to the Google Group');
  // tab B, still showing Test sent, presses it too (or tab A again, after the Sheet didn't answer)
  assert.throws(() => g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Jessie', force: true }), /^Error: Already posted\. To tell the Group about a change, use Draft an update\.$/);
  assert.deepEqual(g.mail.map(m => m.to), ['owner@example.com', 'ebpg@googlegroups.com'], 'one email to the Group');
  const row = postRowOf(g, 'w7', 'ggroup');
  assert.deepEqual([row.status, row['posted by'], row['posted at']], ['posted', 'Phil', at]);
});

test('with test mode back on, Update calendar leaves a real Guild calendar entry as it is', () => {
  const g = seeded();
  setSetting(g, 'TEST_MODE', 'FALSE');
  setSetting(g, 'CALENDAR_ID', 'guild@group.calendar.google.com');
  g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil' });
  const entry = { ...g.calendar[0] };
  setSetting(g, 'TEST_MODE', 'TRUE');
  const moved = toPost({ cols: { ...ev().cols, start: '11:00' } });
  assert.throws(() => g.ctx.postTo(CODE, moved, 'calendar', { by: 'Phil', force: true }), /^Error: Test mode is on, so the Guild calendar is left as it is\. Turn TEST_MODE off on the Settings tab to update it\.$/);
  assert.equal(g.calendar.length, 1);
  assert.deepEqual([g.calendar[0].cal, g.calendar[0].id, g.calendar[0].start.toISOString()], [entry.cal, entry.id, entry.start.toISOString()], 'not moved');
  assert.equal(postRowOf(g, 'w7', 'calendar').status, 'posted');
  // test mode off again: it updates where it is
  setSetting(g, 'TEST_MODE', 'FALSE');
  assert.equal(g.ctx.postTo(CODE, moved, 'calendar', { by: 'Phil', force: true }).message, 'Updated on Guild calendar.');
  assert.deepEqual([g.calendar.length, g.calendar[0].start.toISOString()], [1, '2026-10-25T18:00:00.000Z']);
});

test('a Group email that fails leaves the post approved, with nothing in Activity', () => {
  const g = seeded();
  g.mailbox.fail = () => 'Service invoked too many times for one day: email.';
  const before = g.tab('Activity').length;
  assert.throws(() => g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' }), /too many times/);
  assert.equal(postRowOf(g, 'w7', 'ggroup').status, 'approved');
  assert.equal(g.tab('Activity').length, before);
  g.mailbox.fail = null;
  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' });
  assert.equal(postRowOf(g, 'w7', 'ggroup').status, 'test', 'it can be tried again');
});

test('Update calendar: the stored calendar id gets the new time, title and place, with no second entry, and stale is cleared', () => {
  const g = seeded();
  const first = g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil' });
  const id = postRowOf(g, 'w7', 'calendar')['calendar id'];
  assert.ok(id && id === g.calendar[0].id);
  // the start time changes: the page marks the post stale and saves it
  const moved = toPost({ cols: { ...ev().cols, start: '11:00', place: 'OPC back garden' }, posts: [approved('ggroup', GROUP_TEXT), { ...plain(first.event.posts.calendar), stale: true }] });
  g.ctx.saveEvent(CODE, moved);
  assert.equal(postRowOf(g, 'w7', 'calendar').stale, 'yes');
  assert.equal(plain(g.ctx.signIn(CODE).events[0].posts.calendar.stale), true);
  assert.throws(() => g.ctx.postTo(CODE, moved, 'calendar', { by: 'Phil' }), /^Error: Already posted\. If the event changed, use Update calendar\.$/);
  const out = g.ctx.postTo(CODE, { ...moved, posts: [moved.posts[0], { ...moved.posts[1], text: 'OPC Garden Work Party\nOPC back garden' }] }, 'calendar', { by: 'Jessie', force: true });
  assert.equal(out.message, "Test sent. Test mode is on, so it was updated on the Sheet owner's calendar, marked [TEST].");
  assert.equal(g.calendar.length, 1, 'no duplicate');
  const c = g.calendar[0];
  assert.equal(c.id, id);
  assert.equal(c.start.toISOString(), '2026-10-25T18:00:00.000Z', '11 AM Pacific');
  assert.deepEqual([c.title, c.location, c.description], ['[TEST] OPC Garden Work Party', 'OPC back garden, 111 Fairmount Ave, Oakland', 'OPC Garden Work Party\nOPC back garden']);
  const row = postRowOf(g, 'w7', 'calendar');
  assert.deepEqual([row.status, row['posted by'], row['calendar id'], row.stale], ['test', 'Jessie', id, '']);
  assert.equal(plain(out.event.posts.calendar.stale), false);
  assert.equal(plain(out.event.log).at(-1)[1], "Jessie updated the Calendar (test mode: on the Sheet owner's calendar)");
});

test('Update calendar with no stored id, or an entry deleted by hand, adds a new one', () => {
  const g = seeded();
  g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil' });
  const sh = g.sheets.get('Posts'), r = g.tab('Posts').findIndex(x => x[1] === 'calendar') + 1;
  sh.set(r, g.tab('Posts')[0].indexOf('calendar id') + 1, ''); // a row from before calendar ids
  g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil', force: true });
  assert.equal(g.calendar.length, 2);
  assert.equal(postRowOf(g, 'w7', 'calendar')['calendar id'], g.calendar[1].id);
  g.calendar.splice(1, 1); // deleted in Google Calendar
  g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil', force: true });
  assert.equal(g.calendar.length, 2);
  assert.equal(postRowOf(g, 'w7', 'calendar')['calendar id'], g.calendar[1].id);
});

test('going live after a test: Post for real takes the [TEST] entry off the owner calendar and adds the real one', () => {
  const g = seeded();
  g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil' });
  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' });
  setSetting(g, 'TEST_MODE', 'FALSE');
  setSetting(g, 'GROUP_EMAIL', 'ebpg@googlegroups.com');
  setSetting(g, 'CALENDAR_ID', 'guild@group.calendar.google.com');
  assert.equal(g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil', force: true }).message, 'Added to Guild calendar.');
  assert.deepEqual(g.calendar.map(c => [c.cal, c.title]), [['guild@group.calendar.google.com', 'OPC Garden Work Party']]);
  assert.deepEqual([postRowOf(g, 'w7', 'calendar').status, postRowOf(g, 'w7', 'calendar')['calendar id']], ['posted', g.calendar[0].id]);
  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil', force: true });
  assert.deepEqual([g.mail.at(-1).to, postRowOf(g, 'w7', 'ggroup').status], ['ebpg@googlegroups.com', 'posted']);
  // a later update changes the real entry where it is
  g.ctx.postTo(CODE, toPost({ cols: { ...ev().cols, end: '15:00' } }), 'calendar', { by: 'Phil', force: true });
  assert.equal(g.calendar.length, 1);
  assert.equal(g.calendar[0].end.toISOString(), '2026-10-25T22:00:00.000Z');
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

test('gardens added by hand get map coordinates from the hourly run, not from the public page', () => {
  const g = seeded({ now: BEFORE });
  g.sheets.get('Gardens').set(3, 1, 'Dimond Park'); g.sheets.get('Gardens').set(3, 2, '3860 Hanly Rd, Oakland');
  let pub = plain(g.ctx.getPublic());
  assert.deepEqual(g.geo.asked, [], 'a visitor never waits for the geocoder');
  assert.deepEqual(pub.gardens[1], { name: 'Dimond Park', addr: '3860 Hanly Rd, Oakland', what: '', lat: null, lng: null }, 'in the list, not on the map yet');
  g.ctx.hourly();
  assert.deepEqual(g.geo.asked, ['3860 Hanly Rd, Oakland']);
  pub = plain(g.ctx.getPublic());
  assert.deepEqual([pub.gardens.length, pub.gardens[1].lat, pub.gardens[1].lng], [2, 37.81, -122.25], 'the hourly run cleared the cached public copy');
});

test('JSON API: only the page functions are callable, errors come back as JSON', () => {
  const g = seeded({ now: BEFORE });
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
  const g = gas();
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
  const g = gas();
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
  const g = gas({ now: '2026-10-24T19:00:00-07:00' }); // Sat 7 PM, the event is Sun
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
  const out = gas().ctx.doGet({ parameter: {} }).content;
  const js = out.match(/^<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(!js.includes('//'), 'HtmlService would cut the line at //');
  assert.ok(js.includes('Something went wrong. Please refresh the page. If it keeps happening, email the Guild.'));
  assert.ok(js.includes("b.textContent='Dismiss'"));
  assert.ok(!/Something broke|e\.message\+|monospace/.test(js), 'no raw message on the page');
  assert.ok(/console\.error\(/.test(js), 'details go to the console');
  new vm.Script(js);
});

/* ---------- columns by header, safer writes, and dates typed by hand ---------- */
const vm = require('vm');
const plain = x => JSON.parse(JSON.stringify(x)); // objects from the mock's realm, for deepEqual

test('a column inserted by hand between notes and timeline: the plan, the timeline and saves still line up', () => {
  const g = seeded();
  const sh = g.sheets.get('Events');
  assert.ok(sh.hidden.has(16), "the data (don't edit) column starts hidden");
  sh.insertColumnsAfter(14, 1); // notes is column 14
  sh.set(1, 15, 'Who to thank'); sh.set(2, 15, 'The OPC staff');
  sh.set(1, 3, '  TITLE '); // a header retyped by hand: case and spaces don't matter
  const e = g.ctx.signIn(CODE).events[0];
  assert.equal(e.cols.title, 'OPC Garden Work Party');
  assert.equal(e.cols.notes, 'Bring gloves');
  assert.equal(e.cols.timeline, '10:00 AM Garden work');
  assert.equal(e.data.series, 'workday', 'the plan JSON is found by its header');
  assert.equal(e.data.plan.timeline[0][1], 'Garden work');

  g.ctx.saveEvent(CODE, ev({ cols: { ...ev().cols, notes: 'Bring gloves and hats', timeline: '10:00 AM Mulching' }, data: { ...ev().data, photo: 'moat' } }));
  const [head, row] = g.tab('Events');
  assert.deepEqual(head.slice(13), ['notes', 'Who to thank', 'timeline', "data (don't edit)", 'status', 'rsvp link']);
  assert.equal(row[13], 'Bring gloves and hats');
  assert.equal(row[14], 'The OPC staff', 'the hand-added column is left alone');
  assert.equal(row[15], '10:00 AM Mulching');
  assert.equal(JSON.parse(row[16]).photo, 'moat');
  assert.equal(g.tab('Events').length, 2, 'saved in place, not added again');
  assert.equal(g.ctx.signIn(CODE).events[0].data.photo, 'moat');
});

test('a column added by hand to Settings or Gardens: settings and map points still go in the right cells', () => {
  const g = seeded({ now: BEFORE });
  const s = g.sheets.get('Settings');
  s.insertColumnsAfter(1, 1); s.set(1, 2, 'who set it');
  assert.equal(g.ctx.signIn(CODE).empty, false, 'the organizer code is read from its value column');
  const row = g.tab('Settings').findIndex(r => r[0] === 'SEEDED') + 1;
  s.set(row, 3, ''); s.set(row, 2, 'Jessie');
  g.ctx.doGet({}); // marks a filled Sheet as SEEDED again
  assert.deepEqual(g.tab('Settings')[row - 1].slice(0, 3), ['SEEDED', 'Jessie', 'TRUE']);

  const gs = g.sheets.get('Gardens');
  gs.insertColumnsAfter(3, 1); gs.set(1, 4, 'contact');
  gs.set(3, 1, 'Dimond Park'); gs.set(3, 2, '3860 Hanly Rd, Oakland'); gs.set(3, 4, 'Sky');
  g.ctx.hourly();
  assert.deepEqual(g.tab('Gardens')[2], ['Dimond Park', '3860 Hanly Rd, Oakland', '', 'Sky', '37.81', '-122.25']);
});

test('ensure_ adds a new TABS column after the last used one, without moving any data', () => {
  const g = seeded();
  const sh = g.sheets.get('Bringing');
  sh.set(1, 7, 'my notes'); sh.set(2, 7, 'call Phil first');
  const before = g.tab('Bringing').map(r => r.slice(0, 7));
  vm.runInContext("TABS.Bringing.push('helpers')", g.ctx); // what a later update does
  g.ctx.doGet({});
  const t = g.tab('Bringing');
  assert.deepEqual(t[0], ['event id', 'what', 'who', 'status', 'task id', 'last time', 'my notes', 'helpers']);
  assert.deepEqual(t.map(r => r.slice(0, 7)), before, 'nothing moved');
  assert.equal(sh.formatAt(2, 8), '@', 'the new column is plain text');
  assert.equal(sh.formatAt(1000, 8), '@');
  g.ctx.doGet({});
  assert.equal(g.tab('Bringing')[0].length, 8, 'added once');
  assert.equal(g.ctx.signIn(CODE).events[0].tasks.length, 3, 'still read');
  g.ctx.saveEvent(CODE, ev());
  assert.equal(g.tab('Bringing')[1][6], 'call Phil first', 'a save leaves the hand-added column alone');
});

test('saving one event rewrites only its rows, writes before it clears, and clears only what is left over', () => {
  const g = seeded();
  g.ctx.saveEvent(CODE, ev({ id: 'm2', created: true, cols: { ...ev().cols, title: 'Meeting', date: '2026-11-12' }, tasks: [{ id: 't9', what: 'Notetaker', who: '', status: 'open' }], posts: [], log: [['Nov 1', 'Phil planned it']] }));
  const sh = g.sheets.get('Bringing'), real = sh.getRange.bind(sh), steps = [];
  sh.getRange = (r, c, nr, nc) => {
    const rg = real(r, c, nr, nc), set = rg.setValues.bind(rg), clear = rg.clearContent.bind(rg);
    rg.setValues = v => { steps.push(['write', r, nr]); return set(v); };
    rg.clearContent = () => { steps.push(['clear', r, nr]); return clear(); };
    return rg;
  };
  g.ctx.saveEvent(CODE, ev({ tasks: [{ id: 't1', what: 'Plates and cups', who: 'Phil', status: 'done' }] }));
  assert.deepEqual(steps, [['write', 2, 2], ['clear', 4, 2]], 'the new table first, then only the 2 rows below it');
  assert.deepEqual(g.tab('Bringing').slice(1).map(r => r.slice(0, 4)), [['m2', 'Notetaker', '', 'open'], ['w7', 'Plates and cups', 'Phil', 'done']]);
  assert.equal(sh.getLastRow(), 3);
  assert.deepEqual(g.tab('Activity').filter(r => r[0] === 'm2').map(r => r[2]), ['Phil planned it'], "the other event's activity is kept");
});

test('writing past the bottom of a tab adds rows first, and new cells are plain text', () => {
  const g = seeded();
  const sh = g.sheets.get('Volunteers');
  sh.maxRows = 3; // header and one sign-up, plus one spare row
  g.ctx.addVolunteer({ name: 'Sam Lee', contact: 'sam@example.org', help: [], note: '' });
  g.ctx.addVolunteer({ name: 'Ana Ruiz', contact: '510 555 0101', help: [], note: '' });
  assert.ok(sh.maxRows >= 4, 'insertRowsAfter made room');
  assert.deepEqual(g.tab('Volunteers').map(r => r[1]), ['name', 'Alex R.', 'Sam Lee', 'Ana Ruiz']);
  assert.equal(sh.formatAt(4, 3), '@');
  assert.equal(g.sheets.get('Team').formatAt(2, 5), '', 'Team keeps its checkboxes, so it is not made text');
});

test('Activity keeps the newest 100 lines per event', () => {
  const g = seeded();
  g.ctx.saveEvent(CODE, ev({ id: 'm2', created: true, cols: { ...ev().cols, date: '2026-11-12' }, tasks: [], posts: [], log: [['Nov 1', 'Phil planned it']] }));
  g.ctx.saveEvent(CODE, ev({ log: Array.from({ length: 150 }, (_, i) => ['Oct ' + i, 'step ' + i]) }));
  const mine = g.tab('Activity').filter(r => r[0] === 'w7');
  assert.equal(mine.length, 100);
  assert.equal(mine[0][2], 'step 50');
  assert.equal(mine[99][2], 'step 149');
  assert.equal(g.tab('Activity').filter(r => r[0] === 'm2').length, 1);
});

test("a plan over 45,000 characters is refused, and the event's rows are left as they were", () => {
  const g = seeded();
  const before = ['Events', 'Bringing', 'Posts', 'Activity'].map(g.tab);
  const notes = 'Bring gloves. '.repeat(3300); // about 46,000 characters
  const big = ev({ cols: { ...ev().cols, title: 'Changed', notes }, data: { ...ev().data, plan: { ...ev().data.plan, notes: [notes] } }, tasks: [] });
  assert.throws(() => g.ctx.saveEvent(CODE, big), /^Error: This event's plan is too long to save\. Shorten the notes\.$/);
  assert.deepEqual(['Events', 'Bringing', 'Posts', 'Activity'].map(g.tab), before);
  const call = JSON.parse(g.ctx.doPost({ postData: { contents: JSON.stringify({ fn: 'saveEvent', args: [CODE, big] }) } }).content);
  assert.equal(call.error, "This event's plan is too long to save. Shorten the notes.");
  // other long cells are still capped, not refused
  g.ctx.saveEvent(CODE, ev({ cols: { ...ev().cols, notes } }));
  assert.equal(g.tab('Events')[1][13].length, 45000);
});

test('dates and times typed by hand', () => {
  const g = gas({ now: '2026-03-02T10:00:00-08:00' });
  for (const s of ['2026-10-31', '2026/10/31', '10/31/2026', '10/31/26', 'Oct 31, 2026', 'October 31, 2026', 'Oct. 31 2026', 'oct 31,2026', 'Sat, Oct 31, 2026', 'Saturday, October 31st, 2026', '31 Oct 2026', '10/31', 'Oct 31', '2026-10-31 10:00:00'])
    assert.equal(g.ctx.normDate_(s), '2026-10-31', s);
  assert.equal(g.ctx.normDate_('Sept 3'), '2026-09-03');
  for (const s of ['xyz', 'Feb 30, 2026', '13/45/2026', 'Smarch 3', 'the Saturday after', '2026-10-310', ''])
    assert.equal(g.ctx.isDate_(g.ctx.normDate_(s)), false, s);
  assert.equal(g.ctx.normDate_('  xyz '), 'xyz', 'comes back as typed');
  const times = { noon: '12:00', '12 noon': '12:00', Noon: '12:00', midnight: '00:00', '10am': '10:00', '10 AM': '10:00', '10:30 a.m.': '10:30', '10:30 A.M.': '10:30', '9:30 PM': '21:30', '2:00:00 PM': '14:00', '12am': '00:00', '12pm': '12:00', '14:15': '14:15', '7': '07:00' };
  for (const [s, want] of Object.entries(times)) assert.equal(g.ctx.normTime_(s), want, s);
  for (const s of ['later', '25:00', '13 PM', '10:75']) assert.equal(g.ctx.normTime_(s), s, s);
});

test("hand-typed dates like 'Oct 31, 2026' and times like 'noon' show up as the event's date and time", () => {
  const g = seeded();
  const sh = g.sheets.get('Events');
  sh.set(2, 4, 'Oct 31, 2026'); sh.set(2, 5, 'noon'); sh.set(2, 6, '3pm');
  const e = g.ctx.signIn(CODE).events[0];
  assert.deepEqual([e.cols.date, e.cols.start, e.cols.end], ['2026-10-31', '12:00', '15:00']);
  sh.set(2, 4, '10/31/2026');
  assert.equal(g.ctx.signIn(CODE).events[0].cols.date, '2026-10-31');
});

test("an event row with a date the app can't read is listed in signIn().problems, not dropped silently", () => {
  const g = seeded({ now: BEFORE });
  g.ctx.saveEvent(CODE, ev({ id: 'm2', created: true, cols: { ...ev().cols, title: 'Meeting', date: '2026-11-12' } }));
  const sh = g.sheets.get('Events');
  sh.set(3, 4, 'the Saturday after');
  sh.set(4, 2, 'a note with no id'); // not an event row, so not a problem
  let st = g.ctx.signIn(CODE);
  assert.deepEqual(plain(st.problems), [{ tab: 'Events', row: 3, what: "date 'the Saturday after' not understood" }]);
  assert.deepEqual(plain(st.events.map(e => e.cols.id)), ['w7']);
  assert.equal(g.ctx.getPublic().problems, undefined, 'the public never sees them');
  assert.equal(g.ctx.getPublic().events.length, 1);
  sh.set(3, 4, '');
  assert.deepEqual(plain(g.ctx.signIn(CODE).problems), [{ tab: 'Events', row: 3, what: 'date is blank' }]);
  g.ctx.saveEvent(CODE, ev()); // saving another event leaves that row for the organizer to fix
  assert.equal(g.tab('Events')[2][0], 'm2');
  sh.set(3, 4, 'Nov 12, 2026');
  st = g.ctx.signIn(CODE);
  assert.deepEqual(plain(st.problems), []);
  assert.deepEqual(plain(st.events.map(e => e.cols.id)), ['w7', 'm2']);
});

test('resetStarterData empties only the app\'s own columns', () => {
  const g = seeded();
  const sh = g.sheets.get('Volunteers');
  sh.insertColumnsAfter(2, 1); sh.set(1, 3, 'met at'); sh.set(2, 3, 'the plant sale');
  g.ctx.resetStarterData();
  assert.deepEqual(g.tab('Volunteers')[1], ['', '', 'the plant sale', '', '', '', '', '', '', '', '', '', '', ''], 'the hand-added column is kept');
  assert.equal(g.tab('Events').length, 1);
});

/* ---------- server hardening: the organizer code, stored values, the mail quota and test mode ---------- */
const call = (g, fn, args) => JSON.parse(g.ctx.doPost({ postData: { contents: JSON.stringify({ fn, args }) } }).content);
const settingRow = (g, k) => g.tab('Settings').findIndex(r => r[0] === k) + 1;
const setSetting = (g, k, v) => g.sheets.get('Settings').set(settingRow(g, k), 2, v);
const SET_UP = /^Error: The organizer code isn't set up yet\. Ask the Sheet owner\.$/;

test("a new Sheet's organizer code is blank, and a blank code lets nobody in, even with a blank code", () => {
  const g = makeGas(); // no code in the Settings tab
  g.ctx.doGet({});
  assert.equal(setting(g, 'ORGANIZER_CODE'), '', 'no code ships in the source');
  for (const c of ['', '   ', undefined, null]) assert.throws(() => g.ctx.signIn(c), SET_UP, String(c));
  assert.throws(() => g.ctx.saveEvent('', ev()), SET_UP);
  assert.throws(() => g.ctx.seed('', { events: [ev()] }), SET_UP);
  assert.throws(() => g.ctx.postTo('', 'w7', 'ggroup', 'x'), SET_UP);
  assert.equal(call(g, 'signIn', ['']).error, "The organizer code isn't set up yet. Ask the Sheet owner.");
  assert.equal(call(g, 'saveTeam', [null, team]).error, "The organizer code isn't set up yet. Ask the Sheet owner.");
  assert.equal(g.tab('Events').length, 1, 'nothing saved');
  // a code shorter than 8 characters counts as not set up
  setSetting(g, 'ORGANIZER_CODE', 'bean');
  assert.throws(() => g.ctx.signIn('bean'), SET_UP);
  setSetting(g, 'ORGANIZER_CODE', 'bean-pole');
  assert.equal(g.ctx.signIn('bean-pole').empty, true);
});

test('21 wrong codes in 10 minutes pause every organizer call, even with the right code, until the next 10 minutes', () => {
  const g = gas({ now: '2026-10-24T10:00:00-07:00' });
  g.ctx.doGet({});
  for (let i = 1; i <= 20; i++) assert.throws(() => g.ctx.signIn('guess-' + i), /^Error: That organizer code isn't right\.$/, 'try ' + i);
  assert.throws(() => g.ctx.signIn('guess-21'), /^Error: Too many tries\. Wait 10 minutes and try again\.$/, 'the 21st wrong code');
  assert.throws(() => g.ctx.signIn(CODE), /Too many tries/, 'the right code waits too, so guessing gains nothing');
  assert.throws(() => g.ctx.saveEvent(CODE, ev()), /Too many tries/);
  assert.equal(call(g, 'saveTeam', [CODE, team]).error, 'Too many tries. Wait 10 minutes and try again.');
  assert.equal(g.ctx.getPublic().events.length, 0, 'the public page still works');
  g.clock.now += 10 * 60e3;
  assert.equal(g.ctx.signIn(CODE).empty, true, 'the next 10 minutes start fresh');
  assert.throws(() => g.ctx.signIn('guess-22'), /isn't right/);
});

test('setup gives the Sheet a new organizer code in place of a blank one or the old shipped one, and keeps one chosen by hand', () => {
  for (const old of ['sprout-4821-bay', '']) {
    const g = makeGas({ settings: { ORGANIZER_CODE: old } });
    const out = g.ctx.setup();
    const code = setting(g, 'ORGANIZER_CODE');
    assert.match(code, /^garden-[0-9a-f]{4}-[0-9a-f]{4}$/, JSON.stringify(old));
    assert.ok(out.includes(code), 'setup says what the new code is: ' + out);
    assert.ok(g.logs.some(l => l.includes('New organizer code: ' + code)), 'in the Execution log too, where the editor shows it');
    assert.match(out, /ORGANIZER_CODE row on the Settings tab/);
    assert.throws(() => g.ctx.signIn(old), /isn't right/, 'the old code no longer works');
    assert.equal(g.ctx.signIn(code).empty, true, 'the new one does');
    assert.equal(g.tab('Settings').filter(r => r[0] === 'ORGANIZER_CODE').length, 1, 'one ORGANIZER_CODE row');
  }
  const g = gas();
  assert.ok(!g.ctx.setup().includes('New organizer code'), 'a code chosen by hand is kept');
  assert.equal(setting(g, 'ORGANIZER_CODE'), CODE);
  const short = makeGas({ settings: { ORGANIZER_CODE: 'bean' } });
  assert.match(short.ctx.setup(), /shorter than 8 characters/);
  assert.equal(setting(short, 'ORGANIZER_CODE'), 'bean');
});

test('a saved event keeps only safe values: known photos, https links, plain tags, capped lengths, valid ids and channels', () => {
  const g = seeded();
  const bad = '"><script>alert(1)</script>';
  g.ctx.saveEvent(CODE, ev({
    data: { ...ev().data, photo: bad, map: 'javascript:alert(1)', rsvp: 'http://partiful.com/x', tags: ['beginner', '<img src=x onerror=alert(1)>', 'Bring a hat', 'x'.repeat(31)], title: 'T'.repeat(300), about: 'A'.repeat(5000) },
    cols: { ...ev().cols, title: 'T'.repeat(300), about: 'A'.repeat(5000), bring: 'B'.repeat(600), tags: 'beginner, <b>bold</b>, Bring a hat' },
  }));
  const row = g.tab('Events')[1], head = g.tab('Events')[0], data = JSON.parse(row[head.indexOf("data (don't edit)")]);
  assert.equal(data.photo, 'none', 'an unknown photo is stored as none');
  assert.equal(data.map, undefined, 'a javascript: map link is dropped');
  assert.ok(!data.rsvp, 'an http: RSVP link is dropped');
  assert.equal(row[head.indexOf('rsvp link')], '', 'and not in the rsvp link column');
  assert.deepEqual(data.tags, ['beginner', 'Bring a hat']);
  assert.equal(row[head.indexOf('tags')], 'beginner, Bring a hat');
  assert.equal(row[head.indexOf('title')].length, 200);
  assert.equal(row[head.indexOf('description')].length, 4000);
  assert.equal(row[head.indexOf('bring')].length, 500);
  assert.deepEqual([data.title.length, data.about.length], [200, 4000], "the plan's copies are capped too");
  assert.ok(!JSON.stringify(g.tab('Events')).includes('<script>'));

  // (an older page: the RSVP link in the plan, none in cols)
  g.ctx.saveEvent(CODE, ev({ data: { ...ev().data, photo: 'moat', map: 'https://maps.app.goo.gl/9jQkydC38eJrRScr6', rsvp: 'https://partiful.com/e/abc' }, cols: { ...ev().cols, rsvp: undefined } }));
  const ok = JSON.parse(g.tab('Events')[1][head.indexOf("data (don't edit)")]);
  assert.deepEqual([ok.photo, ok.map, ok.rsvp], ['moat', 'https://maps.app.goo.gl/9jQkydC38eJrRScr6', 'https://partiful.com/e/abc'], 'good values are kept');
  assert.equal(g.tab('Events')[1][head.indexOf('rsvp link')], 'https://partiful.com/e/abc', 'an RSVP link sent in the plan by an older page goes in its column');

  const before = ['Events', 'Bringing', 'Posts'].map(g.tab);
  assert.throws(() => g.ctx.saveEvent(CODE, ev({ id: 'w 7' })), /event id can only use letters, numbers/, 'an id with a space');
  assert.throws(() => g.ctx.saveEvent(CODE, ev({ id: 'x'.repeat(41) })), /event id/, 'an id over 40 characters');
  assert.throws(() => g.ctx.saveEvent(CODE, ev({ id: 'w7"><b>' })), /event id/);
  assert.throws(() => g.ctx.saveEvent(CODE, ev({ tasks: [{ id: 't 1', what: 'Plates', who: '', status: 'open' }] })), /task id/);
  assert.throws(() => g.ctx.saveEvent(CODE, ev({ tasks: [{ what: 'Plates', who: '', status: 'open' }] })), /task id/, 'a task with no id');
  assert.throws(() => g.ctx.saveEvent(CODE, ev({ posts: [{ channel: 'myspace', status: 'review', text: 'x' }] })), /Unknown channel/);
  assert.deepEqual(['Events', 'Bringing', 'Posts'].map(g.tab), before, 'nothing written for a refused save');
  assert.equal(call(g, 'saveEvent', [CODE, ev({ id: 'w 7' })]).error, 'An event id can only use letters, numbers, - and _ (40 at most).');
});

test('an event row whose id was typed with other characters is listed in problems, not shown', () => {
  const g = seeded();
  g.sheets.get('Events').set(2, 1, 'w 7');
  const st = g.ctx.signIn(CODE);
  assert.deepEqual(plain(st.events), []);
  assert.deepEqual(plain(st.problems), [{ tab: 'Events', row: 2, what: 'the id can only use letters, numbers, - and _ (40 at most)' }]);
  assert.equal(g.ctx.getPublic().events.length, 0);
});

test('replies go to REPLY_TO, or to the lead organizer when it is blank', () => {
  const g = seeded();
  assert.equal(setting(g, 'REPLY_TO'), '', 'blank to start');
  g.ctx.addVolunteer({ name: 'Sam Lee', contact: 'sam@example.org', help: [], note: '' });
  assert.equal(g.mail.length, 2);
  assert.ok(g.mail.every(m => m.opts.replyTo === 'jessie@example.org'), JSON.stringify(g.mail.map(m => m.opts)));
  assert.ok(g.mail.every(m => m.opts.name === 'East Bay Permaculture Guild'));
  setSetting(g, 'REPLY_TO', 'hello@eastbaypermaculture.org');
  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' });
  assert.equal(g.mail.at(-1).opts.replyTo, 'hello@eastbaypermaculture.org');
  // no REPLY_TO and a lead with only a phone: no replyTo, so replies go to the owner who sends it
  setSetting(g, 'REPLY_TO', '');
  g.ctx.saveTeam(CODE, team.map(t => t.role === 'lead' ? { ...t, contact: '(510) 555-0100' } : t));
  setSetting(g, 'TEST_MODE', 'FALSE');
  setSetting(g, 'GROUP_EMAIL', 'ebpg@googlegroups.com');
  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil', force: true }); // Post for real
  assert.equal(g.mail.at(-1).to, 'ebpg@googlegroups.com');
  assert.equal(g.mail.at(-1).opts.replyTo, undefined);
});

test('with 20 emails left today, welcome emails wait (noted on the Reminders tab) while reminders still go out', () => {
  const g = seeded({ quota: 20, now: '2026-10-24T19:30:00-07:00' });
  assert.equal(setting(g, 'MAIL_RESERVE'), '30');
  g.ctx.addVolunteer({ name: 'Sam Lee', contact: 'sam@example.org', help: [], note: '' });
  assert.equal(g.mail.length, 0, 'no welcome or new-volunteer email');
  assert.equal(g.tab('Volunteers').length, 3, 'the sign-up is saved');
  assert.deepEqual(g.tab('Reminders').slice(1).map(r => r.slice(1)), [
    ['welcome', 'sam@example.org', 'skipped (quota): Welcome to the East Bay Permaculture Guild'],
    ['lead-alert', 'jessie@example.org', 'skipped (quota): New volunteer: Sam Lee'],
  ]);
  assert.equal(g.ctx.hourly(), 2, 'reminders are not held back');
  assert.equal(g.mail.length, 2);
  // a lower reserve lets them through
  setSetting(g, 'MAIL_RESERVE', '10');
  g.ctx.addVolunteer({ name: 'Ana Ruiz', contact: 'ana@example.org', help: [], note: '' });
  assert.deepEqual(g.mail.slice(2).map(m => m.subject.replace(/^\[TEST to [^\]]+\] /, '')), ['Welcome to the East Bay Permaculture Guild', 'New volunteer: Ana Ruiz']);
});

test("a welcome email that fails doesn't fail the sign-up", () => {
  const g = seeded();
  g.mailbox.fail = (to, subject) => /Welcome/.test(subject) && 'Invalid email: sam@example.org';
  assert.equal(g.ctx.addVolunteer({ name: 'Sam Lee', contact: 'sam@example.org', help: [], note: '' }), true);
  assert.equal(g.tab('Volunteers').length, 3);
  assert.deepEqual(g.tab('Reminders').slice(1).map(r => r.slice(1)), [['welcome', 'sam@example.org', 'failed: Invalid email: sam@example.org']]);
  assert.match(g.mail[0].subject, /New volunteer: Sam Lee/, 'the lead still hears about it');
});

test('hourly keeps going after a send fails, logs it as failed, tries it again next hour, and tells the lead once', () => {
  const g = seeded({ now: '2026-10-24T19:30:00-07:00' }); // Sat 7:30 PM, the event is Sun
  g.mailbox.fail = (to, subject, n) => n === 1 && 'Invalid email: phil@example.org';
  assert.equal(g.ctx.hourly(), 1, 'the text-these-people list still went out');
  const rows = g.tab('Reminders').slice(1);
  const failed = rows.find(r => /^failed: /.test(r[3]));
  assert.ok(failed, JSON.stringify(rows));
  assert.equal(failed[3], 'failed: Invalid email: phil@example.org');
  assert.equal(failed[1], 'failed|w7|t1|evening before', 'logged under a key that does not count as sent');
  assert.ok(g.mail.some(m => /Text these people/.test(m.subject)), 'the next send went out');
  const summary = g.mail.filter(m => /Some reminders didn't go out/.test(m.subject));
  assert.equal(summary.length, 1, 'the lead hears once');
  assert.match(summary[0].subject, /^\[TEST to jessie@example\.org\]/);
  assert.match(summary[0].body, /Reminder: Plates and cups for OPC Garden Work Party \(to phil@example\.org\): Invalid email/);

  // an hour later the failed one goes out, and nothing else repeats
  g.mailbox.fail = null;
  g.clock.now += 3600e3;
  assert.equal(g.ctx.hourly(), 1);
  assert.match(g.mail.at(-1).subject, /\[TEST to phil@example\.org\] Reminder: Plates and cups/);
  assert.equal(g.ctx.hourly(), 0, 'sent now, so not again');

  // everything failing: no summary twice in a day, and no crash
  g.clock.now = new Date('2026-10-25T08:30:00-07:00').getTime();
  g.mailbox.fail = () => 'Service invoked too many times for one day: email.';
  assert.equal(g.ctx.hourly(), 0);
  assert.equal(g.tab('Reminders').filter(r => /^failed: Service invoked/.test(r[3])).length, 2, 'both morning sends logged as failed');
});

test('signIn says whether test mode is on, who gets the emails, whether the Group is set, and the quota left', () => {
  const g = seeded({ quota: 77 });
  let st = g.ctx.signIn(CODE);
  assert.deepEqual([st.testMode, st.owner, st.groupEmailSet, st.quota, st.sheetUrl], [true, 'owner@example.com', false, 77, 'https://docs.google.com/spreadsheets/d/sheet-1/edit']);
  setSetting(g, 'TEST_MODE', 'FALSE');
  setSetting(g, 'GROUP_EMAIL', 'eastbaypermaculture@googlegroups.com');
  st = call(g, 'signIn', [CODE]).value;
  assert.deepEqual([st.testMode, st.groupEmailSet], [false, true]);
  const pub = JSON.stringify(g.ctx.getPublic());
  assert.ok(!pub.includes('owner@example.com') && !/testMode|quota/.test(pub), 'not in the public view');
});

/* ---------- outreach review: who approved, who posted, when, and the link ---------- */
const TRAIL = ['approved by', 'approved at', 'posted at', 'post url', 'calendar id', 'stale'];
const reviewed = () => [
  { channel: 'partiful', status: 'posted', by: 'Phil', text: 'Come dig', edited: false, approvedBy: 'Sky', approvedAt: '2026-10-24T17:05:00.000Z', at: '2026-10-25T16:30:00.000Z', url: 'https://partiful.com/e/abc' },
  { channel: 'ggroup', status: 'approved', by: '', text: 'Subject: Sun 10/25: Work party\n\nHi all,\n\nCome dig.', edited: true, approvedBy: 'Phil', approvedAt: '2026-10-24T18:00:00.000Z', at: '', url: '' },
  { channel: 'instagram', status: 'review', by: '', text: 'Dig day', edited: false, approvedBy: '', approvedAt: '', at: '', url: '' },
];

test('the Posts trail columns round-trip through saveEvent and signIn', () => {
  const g = seeded({ now: BEFORE });
  g.ctx.saveEvent(CODE, ev({ posts: reviewed() }));
  const [head, ...rows] = g.tab('Posts');
  assert.deepEqual(head, ['event id', 'channel', 'status', 'posted by', 'text', 'edited', ...TRAIL]);
  assert.deepEqual(rows.find(r => r[1] === 'partiful'), ['w7', 'partiful', 'posted', 'Phil', 'Come dig', '', 'Sky', '2026-10-24T17:05:00.000Z', '2026-10-25T16:30:00.000Z', 'https://partiful.com/e/abc', '', '']);
  assert.deepEqual(rows.find(r => r[1] === 'ggroup').slice(2), ['approved', '', 'Subject: Sun 10/25: Work party\n\nHi all,\n\nCome dig.', 'yes', 'Phil', '2026-10-24T18:00:00.000Z', '', '', '', '']);
  const posts = plain(g.ctx.signIn(CODE).events.find(e => e.cols.id === 'w7').posts);
  assert.deepEqual(posts.partiful, { channel: 'partiful', status: 'posted', by: 'Phil', text: 'Come dig', edited: false, approvedBy: 'Sky', approvedAt: '2026-10-24T17:05:00.000Z', at: '2026-10-25T16:30:00.000Z', url: 'https://partiful.com/e/abc', stale: false });
  assert.deepEqual([posts.ggroup.status, posts.ggroup.approvedBy, posts.ggroup.approvedAt, posts.ggroup.at, posts.ggroup.url], ['approved', 'Phil', '2026-10-24T18:00:00.000Z', '', '']);
  assert.deepEqual([posts.instagram.status, posts.instagram.approvedBy, posts.instagram.url], ['review', '', '']);
  // saving the same again changes nothing, and the public view never sees any of it
  const before = g.tab('Posts');
  g.ctx.saveEvent(CODE, ev({ posts: reviewed() }));
  assert.deepEqual(g.tab('Posts'), before);
  const pub = g.ctx.getPublic();
  assert.equal(pub.events.length, 1);
  assert.equal(pub.events[0].posts, undefined);
  assert.ok(!/Come dig|Dig day\b.*Instagram|partiful\.com\/e|Sky/.test(JSON.stringify(pub)), 'no post text, links or approvers');
});

test('a post url is kept only when it starts with https://; names and times are capped', () => {
  const g = seeded();
  const bad = ['http://partiful.com/e/abc', 'javascript:alert(1)', 'partiful.com/e/abc', 'https://x.org/a b', 'https://x.org/"><img src=x>', 'https://' + 'a'.repeat(2000), '=HYPERLINK("https://x.org")'];
  bad.forEach(url => {
    g.ctx.saveEvent(CODE, ev({ posts: [{ ...reviewed()[0], url }] }));
    assert.equal(g.tab('Posts')[1][9], '', JSON.stringify(url.slice(0, 40)) + ' is not kept');
  });
  g.ctx.saveEvent(CODE, ev({ posts: [{ ...reviewed()[0], url: '  https://www.instagram.com/p/C9xyz/  ', by: ' ' + 'P'.repeat(90), approvedBy: 'S'.repeat(90), at: '2026-10-25T16:30:00.000Z' + 'x'.repeat(50) }] }));
  const row = g.tab('Posts')[1];
  assert.equal(row[9], 'https://www.instagram.com/p/C9xyz/');
  assert.equal(row[3], 'P'.repeat(60));
  assert.equal(row[6], 'S'.repeat(60));
  assert.equal(row[8].length, 40);
});

test('a Posts tab from before the trail columns gets them at the right end, and its rows still read', () => {
  const g = seeded();
  const sh = g.sheets.get('Posts');
  sh.cells = sh.cells.map(r => r.slice(0, 6)); // the old six columns
  sh.set(1, 7, 'my notes'); sh.set(2, 7, 'ask Jessie first'); // and one added by hand
  const read = plain(g.ctx.signIn(CODE).events[0].posts.ggroup);
  assert.deepEqual([read.status, read.approvedBy, read.approvedAt, read.at, read.url], ['review', '', '', '', '']);
  g.ctx.doGet({});
  assert.deepEqual(g.tab('Posts')[0], ['event id', 'channel', 'status', 'posted by', 'text', 'edited', 'my notes', ...TRAIL]);
  assert.equal(g.tab('Posts')[1][6], 'ask Jessie first', 'nothing moved');
  g.ctx.saveEvent(CODE, ev({ posts: [reviewed()[1]] }));
  const row = g.tab('Posts')[1];
  assert.deepEqual(row.slice(7), ['Phil', '2026-10-24T18:00:00.000Z', '', '', '', '']);
});

/* ---------- a tab left open from before a post can't bring the Post button back ---------- */
test('a stale save after posting (the Group still approved there) leaves the Posts rows posted, and keeps rows that tab never had', () => {
  const g = seeded();
  setSetting(g, 'TEST_MODE', 'FALSE');
  setSetting(g, 'GROUP_EMAIL', 'ebpg@googlegroups.com');
  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' });
  g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil' });
  const KEPT = ['status', 'posted by', 'posted at', 'post url', 'calendar id'];
  const kept = ch => KEPT.map(h => postRowOf(g, 'w7', ch)[h]);
  const before = { ggroup: kept('ggroup'), calendar: kept('calendar') };
  assert.equal(before.ggroup[0], 'posted');
  assert.ok(before.calendar[4], 'a calendar id');
  // the old tab still says approved, and saves an edit to the title
  g.ctx.saveEvent(CODE, toPost({ cols: { ...ev().cols, title: 'OPC Work Party' } }));
  assert.equal(g.tab('Events')[1][2], 'OPC Work Party', 'the rest of the edit is saved');
  assert.deepEqual(kept('ggroup'), before.ggroup);
  assert.deepEqual(kept('calendar'), before.calendar);
  assert.equal(plain(g.ctx.signIn(CODE).events[0].posts.ggroup.status), 'posted', 'the next read says posted');
  // a tab where the Group and the Calendar were never turned on
  g.ctx.saveEvent(CODE, ev({ posts: [] }));
  assert.deepEqual(kept('ggroup'), before.ggroup);
  assert.deepEqual(kept('calendar'), before.calendar);
  // back to a draft with no redo, or one naming another post, doesn't undo it
  g.ctx.saveEvent(CODE, ev({ posts: [{ ...approved('ggroup', 'x'), status: 'review' }] }));
  g.ctx.saveEvent(CODE, ev({ posts: [{ ...approved('ggroup', 'x'), status: 'review', redo: '2020-01-01T00:00:00.000Z' }] }));
  assert.deepEqual(kept('ggroup'), before.ggroup);
  assert.equal(g.mail.length, 1);
  // copy-and-paste channels are the page's own: Undo of Mark as posted still works
  g.ctx.saveEvent(CODE, ev({ posts: [{ ...approved('partiful', 'Come dig'), status: 'posted', by: 'Phil', at: '2026-10-25T16:30:00.000Z' }] }));
  assert.equal(postRowOf(g, 'w7', 'partiful').status, 'posted');
  g.ctx.saveEvent(CODE, ev({ posts: [approved('partiful', 'Come dig')] }));
  assert.equal(postRowOf(g, 'w7', 'partiful').status, 'approved');
});

test('Draft an update: naming the post it replaces makes the Group row a draft again, which needs approval before it goes', () => {
  const g = seeded({ now: '2026-10-24T10:00:00-07:00' });
  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' });
  const at = postRowOf(g, 'w7', 'ggroup')['posted at'];
  assert.equal(at, '2026-10-24T17:00:00.000Z');
  const update = { channel: 'ggroup', status: 'review', by: '', text: 'Subject: Update: OPC Garden Work Party, Sun 10/25\n\nHi all,\n\nNow at 11.', edited: false, approvedBy: '', approvedAt: '', at: '', url: '', stale: false, redo: at };
  g.ctx.saveEvent(CODE, toPost({ posts: [update] }));
  const row = postRowOf(g, 'w7', 'ggroup');
  assert.deepEqual([row.status, row['posted by'], row['posted at'], row.text.split('\n')[0]], ['review', '', '', 'Subject: Update: OPC Garden Work Party, Sun 10/25']);
  assert.throws(() => g.ctx.postTo(CODE, toPost({ posts: [update] }), 'ggroup', { by: 'Phil' }), /Approve it first/);
  g.clock.now += 3600e3;
  g.ctx.postTo(CODE, toPost({ posts: [{ ...update, status: 'approved', approvedBy: 'Jessie', approvedAt: '2026-10-24T17:30:00.000Z' }] }), 'ggroup', { by: 'Jessie' });
  assert.deepEqual(g.mail.map(m => m.subject), ['[TEST to the Google Group] Sun 10/25: Work party', '[TEST to the Google Group] Update: OPC Garden Work Party, Sun 10/25']);
  assert.deepEqual([postRowOf(g, 'w7', 'ggroup').status, postRowOf(g, 'w7', 'ggroup')['posted at']], ['test', '2026-10-24T18:00:00.000Z']);
  // the old marker can't undo the new post
  g.ctx.saveEvent(CODE, toPost({ posts: [update] }));
  assert.equal(postRowOf(g, 'w7', 'ggroup').status, 'test');
  // a row marked posted by hand, with no time: the page sends '-'
  const sh = g.sheets.get('Posts'), r = g.tab('Posts').findIndex(x => x[1] === 'ggroup') + 1;
  sh.set(r, g.tab('Posts')[0].indexOf('posted at') + 1, '');
  g.ctx.saveEvent(CODE, toPost({ posts: [{ ...update, redo: '-' }] }));
  assert.equal(postRowOf(g, 'w7', 'ggroup').status, 'review');
});

test('only postTo marks the Group or the Calendar as sent: a tab from before Draft an update keeps the draft', () => {
  const g = seeded();
  const first = g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' });
  const old = { ...plain(first.event.posts.ggroup), text: GROUP_TEXT }; // what an older tab shows: Test sent, the first email
  const update = { channel: 'ggroup', status: 'review', by: '', text: 'Subject: Update: OPC Garden Work Party, Sun 10/25\n\nNow at 11.', edited: false, approvedBy: '', approvedAt: '', at: '', url: '', stale: false, redo: old.at };
  g.ctx.saveEvent(CODE, toPost({ posts: [update] }));
  assert.equal(postRowOf(g, 'w7', 'ggroup').status, 'review');
  // the older tab saves an edit to the title, still saying sent with the old text
  g.ctx.saveEvent(CODE, toPost({ cols: { ...ev().cols, title: 'OPC Work Party' }, posts: [old] }));
  assert.equal(g.tab('Events')[1][2], 'OPC Work Party', 'the rest of the edit is saved');
  let row = postRowOf(g, 'w7', 'ggroup');
  assert.deepEqual([row.status, row['posted by'], row['posted at'], row.text], ['review', '', '', update.text], 'the update draft is kept');
  // approved in the Sheet: still not sent
  g.ctx.saveEvent(CODE, toPost({ posts: [{ ...update, status: 'approved', approvedBy: 'Jessie', approvedAt: '2026-10-24T18:00:00.000Z' }] }));
  g.ctx.saveEvent(CODE, toPost({ posts: [{ ...old, status: 'posted', by: 'Phil' }] }));
  row = postRowOf(g, 'w7', 'ggroup');
  assert.deepEqual([row.status, row['approved by'], row['posted by'], row.text], ['approved', 'Jessie', '', update.text]);
  // a Calendar row the Sheet has never had can't arrive already sent
  g.ctx.saveEvent(CODE, toPost({ posts: [{ ...approved('calendar', 'OPC Garden Work Party'), status: 'test', by: 'Phil', at: '2026-10-24T18:00:00.000Z' }] }));
  row = postRowOf(g, 'w7', 'calendar');
  assert.deepEqual([row.status, row['posted by'], row['posted at'], row['approved by'], row.text], ['review', '', '', '', 'OPC Garden Work Party']);
  assert.throws(() => g.ctx.postTo(CODE, toPost({ posts: [] }), 'calendar', { by: 'Phil' }), /Approve it first/);
  assert.equal(g.calendar.length, 0);
  assert.equal(g.mail.length, 1);
});

/* ---------- event status, the RSVP link, and the public API's allow-list ---------- */
const evAt = (id, date, over = {}) => ev({ id, created: true, data: { ...ev().data, id }, cols: { ...ev().cols, title: 'Event ' + id, date, ...over }, tasks: [], posts: [], log: [] });
const cellOf = (g, tab, id, head) => { const t = g.tab(tab); return t.find(r => r[0] === id)[t[0].indexOf(head)]; };
const setCell = (g, tab, id, head, v) => { const t = g.tab(tab); g.sheets.get(tab).set(t.findIndex(r => r[0] === id) + 1, t[0].indexOf(head) + 1, v); };

test('getPublic lists only published events from today on: no drafts, cancelled or past ones; a blank status is published', () => {
  const g = seeded({ now: BEFORE });
  g.ctx.saveEvent(CODE, evAt('m2', '2026-11-12', { status: 'draft' }));
  g.ctx.saveEvent(CODE, evAt('c1', '2026-11-01', { status: 'cancelled' }));
  g.ctx.saveEvent(CODE, evAt('p1', '2026-10-01', { status: 'published' }));
  g.ctx.saveEvent(CODE, evAt('b1', '2026-11-22', { status: 'published' }));
  g.ctx.saveEvent(CODE, evAt('t1', '2026-10-24', { status: 'published', start: '18:00' })); // today, this evening
  g.ctx.saveEvent(CODE, evAt('x1', '2026-11-05', { status: 'published' }));
  setCell(g, 'Events', 'b1', 'status', ''); // a row from before the status column
  setCell(g, 'Events', 'x1', 'status', 'not yet'); // a word the app doesn't know
  assert.deepEqual(plain(g.ctx.getPublic().events.map(e => e.id)), ['t1', 'w7', 'b1'], 'sorted by date');
  const st = g.ctx.signIn(CODE);
  assert.deepEqual(plain(Object.fromEntries(st.events.map(e => [e.cols.id, e.cols.status]))),
    { w7: 'published', m2: 'draft', c1: 'cancelled', p1: 'published', b1: 'published', t1: 'published', x1: 'draft' }, 'organizers see every event and its status');
  assert.equal(cellOf(g, 'Events', 'm2', 'status'), 'draft', 'the Sheet says it in words');
});

test("getPublic's JSON has only public fields: no plan, notes, tasks, posts, activity, contacts or permissions", () => {
  const g = gas({ now: BEFORE });
  g.ctx.doGet({});
  const plan = { roles: [['Host', ['Jessie']], ['Co-hosts', ['Phil']]], leadStart: '09:00', leadEnd: '14:30', leadNote: 'Phil has a hard out at 2:30', pending: ['Sky', 'Rob'],
    food: { who: 'Phil', items: 'Plates', menu: 'Saag' }, notes: ['Bring gloves'], debrief: [{ text: 'Buy cattle fence', used: false }],
    timeline: [['09:00', 'Leads set up: snacks and tools', 'Leads'], ['10:00', 'Garden work', ''], ['12:15', 'Lunch', 'Phil']] };
  const w7 = ev({ data: { ...ev().data, plan, map: 'https://maps.app.goo.gl/9jQkydC38eJrRScr6' },
    cols: { ...ev().cols, host: 'Jessie Smith', timeline: '9:00 AM Leads set up: snacks and tools\n10:00 AM Garden work\n12:15 PM Lunch', tags: 'beginner, tools, Bring a hat', rsvp: 'https://partiful.com/e/abc' } });
  g.ctx.seed(CODE, { events: [w7], team, vols: [{ name: 'Alex R.', contact: 'alex@example.org', help: [], note: '' }], gardens: [{ name: 'OPC garden', addr: '111 Fairmount Ave', what: 'Work days', lat: 37.8136, lng: -122.2589 }] });
  const pub = g.ctx.getPublic(), json = JSON.stringify(pub);
  for (const word of ['plan', 'perms', 'leadNote', 'pending', 'food', 'notes', 'contact']) assert.ok(!json.includes(word), word + ' is not in the public JSON');
  for (const text of ['hard out', 'Bring gloves', 'Plates and cups', 'Karen', 'Saag', 'cattle fence', 'Leads set up', 'jessie@example.org', 'alex@example.org', 'Smith', CODE, 'docs.google.com', 'Come dig', "Jessie planned it"])
    assert.ok(!json.includes(text), JSON.stringify(text) + ' is not in the public JSON');
  assert.deepEqual(plain(pub.events[0]), {
    id: 'w7', label: 'Workday #7', title: 'OPC Garden Work Party', date: '2026-10-25', start: '10:00', end: '14:00', place: 'Oakland Peace Center', address: '111 Fairmount Ave, Oakland',
    about: 'Dig day.', bring: 'water', tags: ['beginner', 'tools'], photo: 'trellis', type: 'workday', host: 'Jessie',
    timeline: [['10:00', 'Garden work'], ['12:15', 'Lunch']], map: 'https://maps.app.goo.gl/9jQkydC38eJrRScr6', rsvp: 'https://partiful.com/e/abc',
  });
  assert.deepEqual(plain(pub.team), [{ name: 'Jessie', role: 'lead' }, { name: 'Phil', role: 'co' }]);
  assert.deepEqual(plain(pub.gardens), [{ name: 'OPC garden', addr: '111 Fairmount Ave', what: 'Work days', lat: 37.8136, lng: -122.2589 }]);
  // settings: an allow-list, so the organizer code and the switches never leave the Sheet
  assert.deepEqual(plain(pub.settings), {
    SCHEDULE_TEXT: 'Garden work days at the Oakland Peace Center, plus community meetings with a potluck. Everyone is welcome, no experience needed.',
    WORKDAY_SCHEDULE: '4th Sundays, 10 AM', LINKTREE_URL: 'https://linktr.ee/eastbaypermacultureguild', CONTACT_EMAIL: '' });
  assert.ok(!/ORGANIZER_CODE|TEST_MODE|GROUP_EMAIL|owner@example\.com/.test(json));
  setSetting(g, 'CONTACT_EMAIL', 'hello@eastbaypermaculture.org');
  setSetting(g, 'LINKTREE_URL', 'javascript:alert(1)');
  g.ctx.saveTeam(CODE, team); // clears the cached copy
  assert.deepEqual([g.ctx.getPublic().settings.CONTACT_EMAIL, g.ctx.getPublic().settings.LINKTREE_URL], ['hello@eastbaypermaculture.org', ''], 'only an https Linktree');
});

test('values typed into the Sheet are checked again for the public: unknown photos are none, javascript: maps and http RSVPs are dropped', () => {
  const g = seeded({ now: BEFORE });
  g.ctx.saveEvent(CODE, ev({ data: { ...ev().data, photo: '"><img onerror=x>' } }));
  assert.equal(g.ctx.getPublic().events[0].photo, 'none', 'a photo saved from the page');
  const data = JSON.parse(cellOf(g, 'Events', 'w7', "data (don't edit)"));
  setCell(g, 'Events', 'w7', "data (don't edit)", JSON.stringify({ ...data, photo: '"><img onerror=x>', map: 'javascript:alert(1)', series: '<b>' }));
  setCell(g, 'Events', 'w7', 'rsvp link', 'http://partiful.com/e/abc');
  setCell(g, 'Events', 'w7', 'start', 'whenever');
  setCell(g, 'Events', 'w7', 'timeline', '9:30am Leads arrive\n10 AM Dig\n11:45 Lunch on the patio\nnot a time');
  g.ctx.saveTeam(CODE, team); // the hand edits show once the cached copy goes
  const e = plain(g.ctx.getPublic().events[0]);
  assert.deepEqual([e.photo, e.map, e.rsvp, e.type, e.start], ['none', undefined, undefined, '', '']);
  assert.deepEqual(e.timeline, [['10:00', 'Dig'], ['11:45', 'Lunch on the patio']], 'a timeline changed by hand is read from its cell, without the leads-only rows');
  assert.equal(g.ctx.signIn(CODE).events[0].cols.rsvp, '', 'organizers get the same safe link');
});

test('getPublic is cached for 5 minutes; saving an event, the team, seed and reset clear it at once', () => {
  const g = seeded({ now: BEFORE });
  assert.equal(g.ctx.getPublic().events[0].title, 'OPC Garden Work Party');
  assert.ok(g.cache['public:v1'], 'kept in the script cache');
  setCell(g, 'Events', 'w7', 'title', 'Typed by hand');
  assert.equal(g.ctx.getPublic().events[0].title, 'OPC Garden Work Party', 'the cached copy, for up to 5 minutes');
  g.ctx.saveEvent(CODE, ev({ cols: { ...ev().cols, title: 'Fall Planting Work Party' } }));
  assert.equal(g.ctx.getPublic().events[0].title, 'Fall Planting Work Party', 'a save clears the cache');
  setCell(g, 'Events', 'w7', 'title', 'Typed by hand');
  g.clock.now += 301e3;
  assert.equal(g.ctx.getPublic().events[0].title, 'Typed by hand', 'after 5 minutes it reads the Sheet again');
  // publishing a draft shows it right away
  g.ctx.saveEvent(CODE, evAt('m2', '2026-11-12', { status: 'draft' }));
  assert.deepEqual(plain(g.ctx.getPublic().events.map(e => e.id)), ['w7']);
  g.ctx.saveEvent(CODE, evAt('m2', '2026-11-12', { status: 'published' }));
  assert.deepEqual(plain(g.ctx.getPublic().events.map(e => e.id)), ['w7', 'm2']);
  // the other organizer writes clear it too
  for (const [what, run] of [['saveTeam', () => g.ctx.saveTeam(CODE, team)], ['postTo', () => g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' })],
    ['seed', () => g.ctx.seed(CODE, {})], ['resetStarterData', () => g.ctx.resetStarterData()]]) {
    g.ctx.getPublic();
    assert.ok(g.cache['public:v1'], 'cached before ' + what);
    run();
    assert.equal(g.cache['public:v1'], undefined, what + ' clears it');
  }
  assert.equal(g.ctx.getPublic().events.length, 0, 'after the reset');
});

test("a save while getPublic is reading the Sheet: the older copy isn't cached", () => {
  const g = seeded({ now: BEFORE });
  const read = g.ctx.readTeam_;
  g.ctx.readTeam_ = () => { g.ctx.readTeam_ = read; g.ctx.saveEvent(CODE, ev({ cols: { ...ev().cols, title: 'Saved mid-read' } })); return read(); };
  assert.equal(g.ctx.getPublic().events[0].title, 'OPC Garden Work Party', 'that call read the events before the save');
  assert.equal(g.cache['public:v1'], undefined, 'so it is not kept');
  assert.equal(g.ctx.getPublic().events[0].title, 'Saved mid-read');
  assert.ok(g.cache['public:v1']);
});

test('a public view over 90 KB is not cached, and getPublic reads only the Events, Team, Gardens and Settings tabs', () => {
  const g = seeded({ now: BEFORE });
  const read = g.ctx.rows_, tabs = new Set();
  g.ctx.rows_ = (name, keep) => { tabs.add(name); return read(name, keep); };
  g.ctx.getPublic();
  g.ctx.rows_ = read;
  assert.deepEqual([...tabs].sort(), ['Events', 'Gardens', 'Settings', 'Team']);
  for (let i = 0; i < 24; i++) g.ctx.saveEvent(CODE, evAt('big' + i, '2026-11-' + String(i + 1).padStart(2, '0'), { about: 'Mulch and compost. '.repeat(210) }));
  const pub = g.ctx.getPublic();
  assert.equal(pub.events.length, 25);
  assert.ok(JSON.stringify(pub).length > 90 * 1024);
  assert.equal(g.cache['public:v1'], undefined, 'too big for the cache, so read each time');
  assert.equal(g.ctx.getPublic().events.length, 25);
});

test('new events are drafts; a page that sends no status or RSVP link leaves the Sheet\'s; the RSVP link takes only https', () => {
  const g = seeded({ now: BEFORE });
  const fresh = evAt('n1', '2026-11-08');
  delete fresh.cols.status; delete fresh.cols.rsvp;
  g.ctx.saveEvent(CODE, fresh);
  assert.deepEqual([cellOf(g, 'Events', 'n1', 'status'), cellOf(g, 'Events', 'n1', 'rsvp link')], ['draft', ''], 'a new event with no status is a draft');
  // the page publishes it and adds the Partiful link
  g.ctx.saveEvent(CODE, evAt('n1', '2026-11-08', { status: 'published', rsvp: '  https://partiful.com/e/seedswap  ' }));
  assert.deepEqual([cellOf(g, 'Events', 'n1', 'status'), cellOf(g, 'Events', 'n1', 'rsvp link')], ['published', 'https://partiful.com/e/seedswap']);
  // a tab from before these columns saves it: both stay as they are
  g.ctx.saveEvent(CODE, fresh);
  assert.deepEqual([cellOf(g, 'Events', 'n1', 'status'), cellOf(g, 'Events', 'n1', 'rsvp link')], ['published', 'https://partiful.com/e/seedswap']);
  for (const bad of ['http://partiful.com/e/x', 'javascript:alert(1)', 'partiful.com/e/x', 'https://x.org/"><b>']) {
    g.ctx.saveEvent(CODE, evAt('n1', '2026-11-08', { status: 'published', rsvp: bad }));
    assert.equal(cellOf(g, 'Events', 'n1', 'rsvp link'), '', bad + ' is not kept');
  }
  // the page's own copy in the plan says published, its status says Draft: the column wins, and the plan follows it
  g.ctx.saveEvent(CODE, { ...evAt('n1', '2026-11-08', { status: 'Draft' }), data: { ...ev().data, id: 'n1', status: 'published' } });
  assert.equal(cellOf(g, 'Events', 'n1', 'status'), 'draft');
  const e = plain(g.ctx.signIn(CODE).events.find(x => x.cols.id === 'n1'));
  assert.deepEqual([e.cols.status, e.cols.rsvp, e.data.status], ['draft', '', 'draft'], 'the plan keeps the same status as its column');
});

test('a cancelled event gets no reminders, and a new volunteer hears only about a published event', () => {
  const g = seeded({ now: '2026-10-24T19:30:00-07:00' }); // Sat 7:30 PM, the event is Sun
  setCell(g, 'Events', 'w7', 'status', 'cancelled');
  assert.equal(g.ctx.hourly(), 0);
  assert.equal(g.mail.length, 0);
  setCell(g, 'Events', 'w7', 'status', 'draft');
  g.ctx.addVolunteer({ name: 'Sam Lee', contact: 'sam@example.org', help: [], note: '' });
  assert.ok(!/next gathering|OPC Garden Work Party/.test(g.mail.find(m => /Welcome/.test(m.subject)).body), 'the draft is not announced');
  setCell(g, 'Events', 'w7', 'status', 'published');
  g.ctx.addVolunteer({ name: 'Ana Ruiz', contact: 'ana@example.org', help: [], note: '' });
  assert.match(g.mail.filter(m => /Welcome/.test(m.subject)).at(-1).body, /Our next gathering: OPC Garden Work Party/);
  assert.equal(g.ctx.hourly(), 2, 'reminders go out for a published event');
});

test("gardens the geocoder can't find say 'not found', aren't looked up again, and stay in the list", () => {
  const g = seeded({ now: BEFORE });
  g.geo.find = addr => /Nowhere/.test(addr) ? null : { lat: 37.79, lng: -122.21 };
  const gs = g.sheets.get('Gardens');
  gs.set(3, 1, 'Dimond Park'); gs.set(3, 2, '3860 Hanly Rd, Oakland');
  gs.set(4, 1, 'Mystery plot'); gs.set(4, 2, '1 Nowhere Lane');
  gs.set(5, 1, 'No address yet');
  g.ctx.hourly();
  assert.deepEqual(g.tab('Gardens').slice(2).map(r => [r[3] || '', r[4] || '']), [['37.79', '-122.21'], ['not found', ''], ['', '']]);
  g.ctx.hourly();
  assert.deepEqual(g.geo.asked, ['3860 Hanly Rd, Oakland', '1 Nowhere Lane'], 'looked up once each');
  const pub = plain(g.ctx.getPublic());
  assert.deepEqual(pub.gardens.map(x => [x.name, x.lat]), [['OPC garden', 37.8136], ['Dimond Park', 37.79], ['Mystery plot', null], ['No address yet', null]]);
  // when the geocoder doesn't answer, the row stays blank and is tried again next hour
  g.geo.down = true;
  gs.set(6, 1, 'Lake Merritt garden'); gs.set(6, 2, '666 Bellevue Ave, Oakland');
  g.ctx.hourly();
  assert.equal(g.tab('Gardens')[5][3] || '', '');
  g.geo.down = false;
  g.ctx.hourly();
  assert.equal(g.tab('Gardens')[5][3], '37.79');
  // seed looks up a starter garden that came without a map point
  const h = gas({ now: BEFORE });
  h.ctx.doGet({});
  h.ctx.seed(CODE, { events: [ev()], team, vols: [], gardens: [{ name: 'OPC garden', addr: '111 Fairmount Ave', what: '', lat: '', lng: '' }] });
  assert.deepEqual(h.tab('Gardens')[1].slice(3, 5), ['37.81', '-122.25']);
});

/* ---------- the Channels tab: which channels the Guild uses, their links, and what new events start with ---------- */
const CH_HEAD = ['channel', 'name', 'used', 'link', 'on for new events', 'how it posts'];
const CH_ROWS = [
  ['partiful', 'Partiful', 'TRUE', 'https://partiful.com/', 'TRUE', 'copy and paste'],
  ['ggroup', 'Google Group email', 'TRUE', '', 'TRUE', 'posts automatically'],
  ['calendar', 'Guild Google Calendar', 'TRUE', '', 'TRUE', 'posts automatically'],
  ['facebook', 'Facebook group', 'TRUE', '', 'TRUE', 'copy and paste'],
  ['instagram', 'Instagram', 'TRUE', '', 'TRUE', 'copy and paste'],
  ['chats', 'WhatsApp & Hylo chats', 'TRUE', '', 'TRUE', 'copy and paste'],
  ['luma', 'Luma', 'FALSE', '', 'FALSE', 'copy and paste'],
  ['meetup', 'Meetup', 'FALSE', '', 'FALSE', 'copy and paste'],
];
const chRowAt = (g, id) => g.tab('Channels').findIndex(r => r[0] === id) + 1;
const setCh = (g, id, head, v) => g.sheets.get('Channels').set(chRowAt(g, id), CH_HEAD.indexOf(head) + 1, v);

test("the Channels tab is made once, with the Guild's channels; hand edits and deleted rows are never put back", () => {
  const g = gas();
  g.ctx.doGet({ parameter: {} });
  assert.deepEqual(g.tab('Channels'), [CH_HEAD, ...CH_ROWS]);
  const sh = g.sheets.get('Channels');
  assert.equal(sh.formatAt(2, 4), '@', 'plain text, so a link or TRUE stays as typed');
  // a volunteer adds the Facebook group's link, turns Luma on, and deletes Meetup's row
  setCh(g, 'facebook', 'link', 'https://www.facebook.com/groups/eastbaypermaculture');
  setCh(g, 'luma', 'used', 'TRUE');
  sh.cells[chRowAt(g, 'meetup') - 1] = ['', '', '', '', '', ''];
  const edited = g.tab('Channels');
  g.ctx.doGet({ parameter: {} });
  g.ctx.getPublic();
  g.ctx.seed(CODE, { events: [ev()], team, vols: [], gardens: [] });
  g.ctx.signIn(CODE);
  g.ctx.saveEvent(CODE, ev({ cols: { ...ev().cols, title: 'Fall planting' } }));
  g.ctx.setup();
  assert.deepEqual(g.tab('Channels'), edited, 'kept as the volunteer left it');
  // every row deleted: the tab stays empty, and the page falls back on its own list
  for (let r = 2; r <= sh.cells.length; r++) sh.cells[r - 1] = [];
  g.ctx.doGet({ parameter: {} });
  assert.deepEqual(g.tab('Channels'), [CH_HEAD]);
  assert.deepEqual(plain(g.ctx.signIn(CODE).channels), []);
});

test('an existing Sheet from before the Channels tab gets it on the next load, or the next sign-in, and nothing else changes', () => {
  for (const first of ['doGet', 'signIn']) {
    const g = seeded({ now: BEFORE });
    g.ctx.getPublic(); // cached: the next getPublic doesn't look at the tabs at all
    g.sheets.delete('Channels'); // as a Sheet made before this update
    const others = [...g.sheets.keys()].sort(), before = others.map(k => JSON.stringify(g.tab(k)));
    const st = first === 'doGet' ? (g.ctx.doGet({ parameter: {} }), g.ctx.signIn(CODE)) : g.ctx.signIn(CODE);
    assert.deepEqual(g.tab('Channels'), [CH_HEAD, ...CH_ROWS], first);
    assert.equal(st.channels.length, 8, first);
    assert.deepEqual(others.map(k => JSON.stringify(g.tab(k))), before, first + ': the other tabs are as they were');
  }
});

test('signIn and seed return the channels as the page uses them: yes or no, https links only, unknown and repeated ids left out', () => {
  const g = seeded();
  const st = g.ctx.signIn(CODE);
  assert.deepEqual(plain(st.channels), CH_ROWS.map(r => ({ id: r[0], name: r[1], used: r[2] === 'TRUE', link: r[3], onNew: r[4] === 'TRUE' })));
  const h = gas();
  h.ctx.doGet({});
  assert.equal(h.ctx.seed(CODE, { events: [ev()], team, vols: [], gardens: [] }).channels.length, 8, 'seed answers with them too');
  // typed by hand
  setCh(g, 'luma', 'used', 'yes'); setCh(g, 'luma', 'on for new events', 'x'); setCh(g, 'luma', 'link', ' https://lu.ma/ebpg ');
  setCh(g, 'facebook', 'link', 'http://facebook.com/groups/ebpg'); // not https
  setCh(g, 'instagram', 'used', ''); setCh(g, 'instagram', 'link', 'javascript:alert(1)');
  setCh(g, 'chats', 'name', '  WhatsApp group  ');
  setCh(g, 'partiful', 'channel', ' Partiful ');
  const sh = g.sheets.get('Channels');
  [['myspace', 'MySpace', 'TRUE', 'https://myspace.com/', 'TRUE', ''], ['partiful', 'Partiful again', 'FALSE', '', 'FALSE', '']]
    .forEach((row, i) => row.forEach((v, j) => sh.set(10 + i, j + 1, v)));
  const by = Object.fromEntries(plain(g.ctx.signIn(CODE).channels).map(c => [c.id, c]));
  assert.deepEqual(Object.keys(by), ['partiful', 'ggroup', 'calendar', 'facebook', 'instagram', 'chats', 'luma', 'meetup'], 'no myspace, and one partiful');
  assert.deepEqual(by.luma, { id: 'luma', name: 'Luma', used: true, link: 'https://lu.ma/ebpg', onNew: true });
  assert.equal(by.facebook.link, '');
  assert.deepEqual([by.instagram.used, by.instagram.link], [false, '']);
  assert.equal(by.chats.name, 'WhatsApp group');
  assert.deepEqual(by.partiful, { id: 'partiful', name: 'Partiful', used: true, link: 'https://partiful.com/', onNew: true }, 'the first row for a channel wins');
  assert.ok(!('channels' in plain(g.ctx.getPublic())), 'not in the public view');
});

/* ---------- volunteer sign-up: the form's answers, bots, retries and people signing up again ---------- */
const VOL = (over = {}) => ({ name: 'Maya Ortiz', email: 'maya@example.org', phone: '', best: 'Email', help: ['Garden work days'], free: ['Weekend mornings'], heard: 'Instagram', note: '', list: false, event: '', id: 'c-' + Math.random().toString(36).slice(2, 12), elapsed: 9000, website: '', ...over });
const volRows = g => { const [head, ...rows] = g.tab('Volunteers'); return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : r[i]]))); };
const welcomes = g => g.mail.filter(m => /Welcome to the East Bay Permaculture Guild/.test(m.subject));
const HOUR = 3600e3;

test('a sign-up fills the new Volunteers columns, keeps contact filled, and the welcome links the next event and says to reply', () => {
  const g = seeded({ now: BEFORE });
  assert.deepEqual(g.tab('Volunteers')[0].slice(5), ['id', 'email', 'phone', 'best way', 'free', 'heard from', 'email list', 'event'], 'added at the end');
  assert.equal(g.ctx.addVolunteer(VOL({ phone: '(510) 555-0101', best: 'Text', help: ['Garden work days', 'Host a project'], free: ['Weekend mornings', 'One-off projects'], heard: 'A flyer', list: true, event: 'w7', note: 'I have a truck' })), true);
  const r = volRows(g).find(x => x.name === 'Maya Ortiz');
  assert.match(r.id, /^[0-9a-f]{8}$/, 'a short id');
  assert.deepEqual([r['signed up'], r.contact, r.email, r.phone, r['best way'], r['wants to help with'], r.free, r['heard from'], r['email list'], r.event, r.note],
    ['2026-10-24', 'maya@example.org', 'maya@example.org', '(510) 555-0101', 'Text', 'Garden work days, Host a project', 'Weekend mornings, One-off projects', 'A flyer', 'yes', 'w7', 'I have a truck']);
  // phone only: contact is the phone, and the best way is a text
  g.ctx.addVolunteer(VOL({ name: 'Ana Ruiz', email: '', phone: '510 555 0199', best: '' }));
  const a = volRows(g).find(x => x.name === 'Ana Ruiz');
  assert.deepEqual([a.contact, a.email, a.phone, a['best way'], a['email list']], ['510 555 0199', '', '510 555 0199', 'Text', '']);
  // the welcome: to Maya, about the event she's coming to, with its page, ending with the reply line
  const w = welcomes(g);
  assert.equal(w.length, 1, 'only Maya has an email');
  assert.equal(w[0].subject, '[TEST to maya@example.org] Welcome to the East Bay Permaculture Guild');
  assert.match(w[0].body, /^Hi Maya,\n\nThanks for signing up to help with garden work days and hosting a project\. An organizer will reach out soon\./);
  assert.match(w[0].body, /See you at OPC Garden Work Party, Sunday, October 25 at 10 AM, Oakland Peace Center\.\nDetails and directions: http:\/\/localhost:8766\/\?ev=w7\n/);
  assert.match(w[0].body, /\n\nJust reply to this email if you have questions\.$/);
  assert.equal(w[0].opts.replyTo, 'jessie@example.org', 'replies go to the lead (REPLY_TO is blank)');
  // the lead hears everything the form asked
  const lead = g.mail.find(m => /New volunteer: Maya Ortiz/.test(m.subject));
  for (const line of ['Email: maya@example.org', 'Phone: (510) 555-0101', 'Best way to reach them: a text', 'Wants to help with: Garden work days, Host a project',
    'Usually free: Weekend mornings, One-off projects', 'Heard about us from: A flyer', 'Guild email list: yes, please add them', 'Coming to: OPC Garden Work Party, Sunday, October 25 at 10 AM, Oakland Peace Center', 'Note: I have a truck']) {
    assert.ok(lead.body.split('\n').includes(line), line);
  }
  // with SITE_URL set, the link is the public site's event page
  setSetting(g, 'SITE_URL', 'https://ebpg-event-hub.netlify.app/');
  g.ctx.addVolunteer(VOL({ name: 'Lee Park', email: 'lee@example.org' }));
  assert.match(welcomes(g).at(-1).body, /Our next gathering: OPC Garden Work Party, .*\nDetails and directions: https:\/\/ebpg-event-hub\.netlify\.app\/\?ev=w7\n/);
});

test('a filled-in honeypot, or a form sent 1 second after it opened, writes nothing and sends nothing, but says it went fine', () => {
  const g = seeded({ now: BEFORE });
  const before = JSON.stringify(g.tab('Volunteers'));
  assert.equal(g.ctx.addVolunteer(VOL({ website: 'https://spam.example' })), true);
  assert.equal(g.ctx.addVolunteer(VOL({ elapsed: 1000 })), true);
  assert.equal(g.ctx.addVolunteer(VOL({ website: 'x', name: '' })), true, 'not even checked');
  assert.equal(JSON.stringify(g.tab('Volunteers')), before);
  assert.equal(g.mail.length, 0);
  assert.equal(call(g, 'addVolunteer', [VOL({ elapsed: 1000 })]).value, true, 'the same through the web app');
  assert.equal(JSON.stringify(g.tab('Volunteers')), before);
  // 3 seconds is fine
  g.ctx.addVolunteer(VOL({ elapsed: 3000 }));
  assert.equal(volRows(g).length, 2);
  // below 0: the visitor's clock went back while the form was open (a real person, so it's kept)
  g.ctx.addVolunteer(VOL({ name: 'Lee Park', email: 'lee@example.org', elapsed: -5000 }));
  assert.ok(volRows(g).some(r => r.name === 'Lee Park'), 'kept');
  assert.equal(welcomes(g).length, 2);
});

test('the server checks every answer: name, email, phone, choices and the note', () => {
  const g = seeded({ now: BEFORE });
  const no = (over, re) => assert.throws(() => g.ctx.addVolunteer(VOL(over)), re, JSON.stringify(over));
  no({ name: '' }, /^Error: Add your name so we know who to welcome\.$/);
  no({ name: 'Maya <b>' }, /letters, spaces and \. ' - only/);
  no({ name: '1234' }, /letters, spaces/);
  no({ name: 'M'.repeat(81) }, /80 characters at most/);
  no({ email: 'maya@example' }, /That email address doesn't look right/);
  no({ email: 'maya example.org' }, /email address/);
  no({ email: '', phone: '' }, /Add an email or phone number/);
  no({ email: '', phone: '555-012' }, /at least 7 digits/);
  no({ email: '', phone: 'call me maybe 5105550101' }, /phone number/);
  no({ help: ['Garden work days', '@everyone'] }, /isn't on the form anymore/);
  no({ free: ['Never'] }, /isn't on the form anymore/);
  no({ heard: 'A billboard' }, /isn't on the form anymore/);
  no({ best: 'Carrier pigeon' }, /isn't on the form anymore/);
  no({ note: 'x'.repeat(1001) }, /under 1,000 characters/);
  assert.equal(volRows(g).length, 1, 'nothing saved');
  assert.deepEqual(call(g, 'addVolunteer', [VOL({ email: 'nope' })]), { error: "That email address doesn't look right. Please check it." });
  // these are fine: accents, apostrophes (straight and curly), hyphens, initials, a 1,000-character note, choices in any case
  for (const name of ["Zoë D'Angelo", 'Mary-Kate O’Neil', 'J. R. Smith', 'Nguyễn Văn An']) g.ctx.addVolunteer(VOL({ name, email: '', phone: '+1 510 555 ' + String(1000 + volRows(g).length) }));
  g.ctx.addVolunteer(VOL({ email: 'kai@example.org', name: 'Kai', note: 'y'.repeat(1000), help: ['garden WORK days'] }));
  assert.equal(volRows(g).length, 6);
  assert.equal(volRows(g).at(-1)['wants to help with'], 'Garden work days', 'kept in the form\'s own words');
});

test('the welcome greeting is a plain first name, or "there"', () => {
  const g = seeded({ now: BEFORE });
  g.ctx.addVolunteer(VOL({ name: "Zoë D'Angelo", email: 'zoe@example.org' }));
  g.ctx.addVolunteer(VOL({ name: 'Www.spam.example Click now', email: 'victim@example.org' }));
  g.ctx.addVolunteer(VOL({ name: 'Mary-Kate Olsen', email: 'mk@example.org' }));
  assert.deepEqual(welcomes(g).map(m => m.body.split('\n')[0]), ['Hi Zoë,', 'Hi there,', 'Hi Mary-Kate,']);
});

test('the welcome says each way to help as a phrase, joined with commas and "and"', () => {
  const g = seeded({ now: BEFORE });
  const help = plain(require('vm').runInContext('VOL_HELP', g.ctx)), say = plain(require('vm').runInContext('VOL_HELP_SAY', g.ctx));
  assert.equal(say.length, help.length, 'a phrase for every choice');
  const thanks = over => { g.ctx.addVolunteer(VOL({ name: 'Kai', email: `k${welcomes(g).length}@example.org`, ...over })); return welcomes(g).at(-1).body.split('\n')[2]; };
  assert.equal(thanks({ help: ['Partner organization'] }), 'Thanks for signing up to help with partnering as an organization. An organizer will reach out soon.');
  assert.equal(thanks({ help: ['Meeting setup', 'Adopt a plant', 'Host a project'] }), 'Thanks for signing up to help with setting up for meetings, adopting a plant and hosting a project. An organizer will reach out soon.');
  assert.equal(thanks({ help: [] }), 'Thanks for signing up to help. An organizer will reach out soon.');
  assert.equal(thanks({ help: help }), 'Thanks for signing up to help with ' + say.slice(0, -1).join(', ') + ' and ' + say.at(-1) + '. An organizer will reach out soon.');
});

test("the welcome's next gathering is the page's next event: today's once over are left out, and a day goes by start time", () => {
  const g = seeded({ now: BEFORE }); // Saturday 10 AM
  const add = (id, title, date, start, end, status = 'published') => g.ctx.saveEvent(CODE, ev({ id, created: true, cols: { ...ev().cols, title, date, start, end, status }, tasks: [], posts: [] }));
  add('s1', 'Sunrise Seed Swap', '2026-10-24', '08:00', '09:30'); // over by 10 AM
  add('s2', 'Early Mulch Crew', '2026-10-25', '08:30', '09:30'); // the same day as w7, earlier, and saved after it
  add('s3', 'Draft Planning Call', '2026-10-24', '18:00', '19:00', 'draft');
  const next = () => welcomes(g).at(-1).body.match(/Our next gathering: ([^,]+),/)[1];
  g.ctx.addVolunteer(VOL({ email: 'a@example.org' }));
  assert.equal(next(), 'Early Mulch Crew');
  add('s4', 'Pruning Walk', '2026-10-24', '09:00', '11:00'); // on now: still the next one, as on the page
  g.ctx.addVolunteer(VOL({ name: 'Ben', email: 'b@example.org' }));
  assert.equal(next(), 'Pruning Walk');
  g.clock.now += 1.5 * HOUR; // 11:30: it's over
  g.ctx.addVolunteer(VOL({ name: 'Cleo', email: 'c@example.org' }));
  assert.equal(next(), 'Early Mulch Crew');
  // coming to an event that's over: the next one instead
  g.ctx.addVolunteer(VOL({ name: 'Dee', email: 'd@example.org', event: 's4' }));
  assert.equal(next(), 'Early Mulch Crew');
});

test('someone already on the list (the same email or phone, and first name) gets their row updated, with one row and one welcome', () => {
  const g = seeded({ now: BEFORE });
  g.ctx.addVolunteer(VOL({ phone: '(510) 555-0101', help: ['Garden work days'], free: ['Weekend mornings'], note: 'Has a truck' }));
  const id = volRows(g).find(r => r.name === 'Maya Ortiz').id;
  g.clock.now += HOUR + 1000; // after the hour's cooldown
  g.ctx.addVolunteer(VOL({ name: 'Maya O', email: 'MAYA@example.org ', phone: '', help: ['Host a project', 'Garden work days'], free: ['Weekday evenings'], heard: 'A friend', list: true, event: 'w7', note: 'Now with a project' }));
  let rows = volRows(g).filter(r => r.email.toLowerCase() === 'maya@example.org');
  assert.equal(rows.length, 1, 'one row');
  let r = rows[0];
  assert.deepEqual([r.id, r.name, r['wants to help with'], r.free, r['heard from'], r['email list'], r.event, r.phone],
    [id, 'Maya Ortiz', 'Garden work days, Host a project', 'Weekend mornings, Weekday evenings', 'Instagram', 'yes', 'w7', '(510) 555-0101'], 'choices added, the name and first answer kept');
  assert.equal(r.note, 'Has a truck\nSigned up again 2026-10-24 as Maya O: Now with a project', 'the name she gave this time, in the note');
  assert.equal(welcomes(g).length, 1, 'one welcome in all');
  assert.equal(g.mail.at(-1).subject, '[TEST to jessie@example.org] Volunteer signed up again: Maya O');
  // the phone, written another way, with a new email
  g.clock.now += HOUR + 1000;
  g.ctx.addVolunteer(VOL({ email: 'maya.o@example.org', phone: '+1 510 555 0101', note: '' }));
  rows = volRows(g).filter(x => x.id === id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, 'Has a truck\nSigned up again 2026-10-24 as Maya O: Now with a project\nSigned up again 2026-10-24 with email maya.o@example.org');
  assert.equal(rows[0].email, 'maya@example.org', 'the email on file stays');
  assert.equal(welcomes(g).length, 1);
  // a row from before the email and phone columns is found by its contact
  const sh = g.sheets.get('Volunteers'), head = g.tab('Volunteers')[0];
  const alex = volRows(g).findIndex(x => x.name === 'Alex R.') + 2;
  assert.equal(g.tab('Volunteers')[alex - 1][head.indexOf('contact')], 'alex@example.org');
  sh.set(alex, head.indexOf('email') + 1, '');
  g.ctx.addVolunteer(VOL({ name: 'Alex Rivera', email: 'alex@example.org', help: ['Meeting setup'] }));
  assert.equal(volRows(g).filter(x => x.contact === 'alex@example.org').length, 1);
  assert.equal(volRows(g).find(x => x.contact === 'alex@example.org')['wants to help with'], 'Garden work days, Meeting setup');
});

test('the same client id twice gives one row; the same person again within the hour has their answers kept, with no email', () => {
  const g = seeded({ now: BEFORE });
  const one = VOL({ id: 'a1b2c3d4-0000-4000-8000-000000000001' });
  assert.equal(g.ctx.addVolunteer(one), true);
  assert.equal(g.ctx.addVolunteer(one), true, 'Try again after a send that got through');
  assert.equal(g.ctx.addVolunteer({ ...one, email: 'someone.else@example.org', name: 'Someone Else' }), true, 'the same id is ignored for 10 minutes');
  assert.equal(volRows(g).length, 2, 'Alex and Maya');
  assert.equal(welcomes(g).length, 1);
  const sent = g.mail.length, maya = () => volRows(g).find(r => r.name === 'Maya Ortiz' && r.email === 'maya@example.org');
  // a new id, the same email and name: her correction is kept in her row, and nobody is emailed about it again
  assert.equal(g.ctx.addVolunteer(VOL({ note: 'Again', help: ['Teaching a skill'], free: ['Weekday evenings'] })), true);
  assert.deepEqual([maya().note, maya()['wants to help with'], maya().free], ['Signed up again 2026-10-24: Again', 'Garden work days, Teaching a skill', 'Weekend mornings, Weekday evenings']);
  assert.equal(g.mail.length, sent, 'no welcome and no lead alert within the hour');
  g.ctx.addVolunteer(VOL({ note: 'Again', help: ['Teaching a skill'] }));
  assert.equal(maya().note, 'Signed up again 2026-10-24: Again', 'the same answers twice: one line');
  // her phone, on its own: a new row (nothing ties it to her email yet), with a lead alert
  g.ctx.addVolunteer(VOL({ email: '', phone: '510 555 0101' }));
  assert.equal(volRows(g).length, 3);
  assert.equal(g.mail.length, sent + 1);
  // that phone with an email, within the hour: the email goes on the phone's row, and nothing is sent
  g.ctx.addVolunteer(VOL({ email: 'other@example.org', phone: '(510) 555-0101', note: 'My other email' }));
  assert.equal(volRows(g).length, 3, 'kept in the row with that phone');
  const tel = volRows(g).find(r => r.phone === '510 555 0101');
  assert.deepEqual([tel.email, tel.note], ['other@example.org', 'Signed up again 2026-10-24: My other email']);
  assert.equal(g.mail.length, sent + 1);
  g.clock.now += 11 * 60e3;
  g.ctx.addVolunteer({ ...one, email: 'someone.else@example.org', name: 'Someone Else' });
  assert.equal(volRows(g).length, 4, 'after 10 minutes the id counts as new');
});

test('two people on one email or phone are two people: a row each, the lead hears about each, and the inbox gets one welcome', () => {
  const g = seeded({ now: BEFORE });
  g.ctx.addVolunteer(VOL({ name: 'Ana Smith', email: 'smiths@example.org', help: ['Garden work days'] }));
  assert.equal(g.ctx.addVolunteer(VOL({ name: 'Ben Smith', email: 'Smiths@example.org', help: ['Teaching a skill'], note: 'I can teach grafting' })), true);
  const smiths = () => volRows(g).filter(r => r.email.toLowerCase() === 'smiths@example.org').map(r => [r.name, r['wants to help with'], r.note]);
  assert.deepEqual(smiths(), [['Ana Smith', 'Garden work days', ''], ['Ben Smith', 'Teaching a skill', 'I can teach grafting']]);
  assert.equal(welcomes(g).length, 1, 'one welcome to the shared inbox');
  const ben = g.mail.find(m => /New volunteer: Ben Smith$/.test(m.subject));
  assert.ok(ben, 'the lead hears about Ben');
  assert.ok(ben.body.split('\n').includes('Shares this email with Ana Smith. They have a row of their own, and no second welcome went to that address.'));
  // a third, an hour later: her own row, with her name and answers
  g.clock.now += HOUR + 1000;
  g.ctx.addVolunteer(VOL({ name: 'Cleo Smith', email: 'smiths@example.org', note: 'hi' }));
  assert.deepEqual(smiths().map(r => r[0]), ['Ana Smith', 'Ben Smith', 'Cleo Smith']);
  assert.equal(smiths()[2][2], 'hi');
  assert.equal(smiths()[0][2], '', "Ana's row is still hers");
  assert.match(g.mail.find(m => /New volunteer: Cleo Smith$/.test(m.subject)).body, /\nShares this email with Ana Smith and Ben Smith\./);
  // Ana again, her name in another case: her own row, and no second welcome
  g.ctx.addVolunteer(VOL({ name: 'ana smith', email: 'smiths@example.org', help: ['Host a project'], note: 'Back' }));
  assert.equal(smiths().length, 3);
  assert.deepEqual(smiths()[0], ['Ana Smith', 'Garden work days, Host a project', 'Signed up again 2026-10-24: Back']);
  assert.equal(g.mail.at(-1).subject, '[TEST to jessie@example.org] Volunteer signed up again: ana smith');
  // and within the hour, as Ana S.: kept, with the name she gave, and no email
  const sent = g.mail.length;
  g.ctx.addVolunteer(VOL({ name: 'Ana S.', email: 'smiths@example.org', note: 'New phone soon' }));
  assert.equal(smiths()[0][2], 'Signed up again 2026-10-24: Back\nSigned up again 2026-10-24 as Ana S.: New phone soon');
  assert.equal(g.mail.length, sent);
  assert.equal(welcomes(g).length, 1);
  // a shared phone works the same way; a new email on it still gets its welcome
  g.ctx.addVolunteer(VOL({ name: 'Rosa Diaz', email: '', phone: '(510) 555-0177' }));
  g.ctx.addVolunteer(VOL({ name: 'Tomas Diaz', email: 'tomas@example.org', phone: '510 555 0177' }));
  assert.deepEqual(volRows(g).filter(r => /Diaz/.test(r.name)).map(r => [r.name, r.email]), [['Rosa Diaz', ''], ['Tomas Diaz', 'tomas@example.org']]);
  assert.equal(welcomes(g).at(-1).subject, '[TEST to tomas@example.org] Welcome to the East Bay Permaculture Guild');
  assert.ok(g.mail.find(m => /New volunteer: Tomas Diaz$/.test(m.subject)).body.split('\n').includes('Shares this phone with Rosa Diaz. They have a row of their own.'));
});

test('the global limit: 60 sign-ups every 10 minutes, then a friendly message', () => {
  const g = seeded({ now: '2026-10-24T10:00:30-07:00' });
  for (let i = 0; i < 60; i++) g.ctx.addVolunteer(VOL({ name: 'Volunteer', email: `v${i}@example.org` }));
  assert.equal(volRows(g).length, 61);
  assert.throws(() => g.ctx.addVolunteer(VOL({ email: 'late@example.org' })), /^Error: Lots of sign-ups right now\. Please try again in a few minutes\.$/);
  // bots and retries don't use it up
  assert.equal(g.ctx.addVolunteer(VOL({ website: 'x' })), true);
  g.clock.now += 10 * 60e3;
  g.ctx.addVolunteer(VOL({ email: 'late@example.org' }));
  assert.equal(volRows(g).length, 62, 'the next 10 minutes');
});

test('with 20 emails left today a sign-up is saved and its welcome waits', () => {
  const g = seeded({ now: BEFORE, quota: 20 });
  g.ctx.addVolunteer(VOL({ phone: '510 555 0101', free: ['One-off projects'] }));
  const r = volRows(g).find(x => x.name === 'Maya Ortiz');
  assert.deepEqual([r.email, r.phone, r.free], ['maya@example.org', '510 555 0101', 'One-off projects'], 'saved, with every answer');
  assert.equal(g.mail.length, 0);
  assert.deepEqual(g.tab('Reminders').slice(1).map(x => x[3]), ['skipped (quota): Welcome to the East Bay Permaculture Guild', 'skipped (quota): New volunteer: Maya Ortiz']);
});

test('volunteers with no id (from before the column, or typed in by hand) get one; signIn hands organizers every answer', () => {
  const g = seeded({ now: BEFORE });
  const sh = g.sheets.get('Volunteers'), head = g.tab('Volunteers')[0], col = h => head.indexOf(h) + 1;
  assert.match(g.tab('Volunteers')[1][col('id') - 1], /^[0-9a-f]{8}$/, 'the seed gives one');
  sh.set(2, col('id'), '');
  sh.set(3, col('signed up'), '2026-10-20'); sh.set(3, col('name'), 'Typed In'); sh.set(3, col('contact'), '(510) 555-0144');
  g.ctx.doGet({});
  const t = g.tab('Volunteers');
  assert.match(t[1][col('id') - 1], /^[0-9a-f]{8}$/);
  assert.match(t[2][col('id') - 1], /^[0-9a-f]{8}$/);
  assert.notEqual(t[1][col('id') - 1], t[2][col('id') - 1]);
  const id = t[1][col('id') - 1];
  g.ctx.doGet({});
  assert.equal(g.tab('Volunteers')[1][col('id') - 1], id, 'an id never changes');
  g.ctx.addVolunteer(VOL({ phone: '510 555 0101', best: 'Text', list: true, event: 'w7', free: ['Weekday evenings'], heard: 'Partiful' }));
  const vols = plain(g.ctx.signIn(CODE).vols);
  assert.deepEqual(vols.find(v => v.name === 'Typed In'), { date: '2026-10-20', name: 'Typed In', contact: '(510) 555-0144', help: [], note: '', id: g.tab('Volunteers')[2][col('id') - 1], email: '', phone: '(510) 555-0144', best: '', free: [], heard: '', list: false, event: '' });
  const m = vols.find(v => v.name === 'Maya Ortiz');
  assert.deepEqual([m.email, m.phone, m.best, m.help, m.free, m.heard, m.list, m.event], ['maya@example.org', '510 555 0101', 'Text', ['Garden work days'], ['Weekday evenings'], 'Partiful', true, 'w7']);
  assert.ok(!('vols' in plain(g.ctx.getPublic())), 'never in the public view');
});

/* ---------- Cancel event, Delete draft, and no saves that bring back an event taken out of the Sheet ---------- */
const NOTICE = 'Cancelled: OPC Garden Work Party on Sunday, October 25. Heavy rain is forecast. Sorry for the change. We hope to see you at the next one.';
const rowsFor = (g, tab, id) => g.tab(tab).filter(r => r[0] === id);

test('Cancel event: off the public page, no reminders, the Calendar entry deleted, and a notice to approve for each channel already posted', () => {
  const g = seeded({ now: '2026-10-24T19:30:00-07:00' }); // Sat 7:30 PM: reminders would go out tonight
  setSetting(g, 'TEST_MODE', 'FALSE');
  setSetting(g, 'GROUP_EMAIL', 'ebpg@googlegroups.com');
  setSetting(g, 'CALENDAR_ID', 'guild@group.calendar.google.com');
  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' });
  g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil' });
  // Partiful marked posted with its link; Instagram still a draft nobody posted
  const partiful = { channel: 'partiful', status: 'posted', by: 'Phil', text: 'Come dig', edited: false, approvedBy: 'Phil', approvedAt: '2026-10-20T18:00:00.000Z', at: '2026-10-20T19:00:00.000Z', url: 'https://partiful.com/e/w7' };
  g.ctx.saveEvent(CODE, ev({ posts: [partiful, { channel: 'instagram', status: 'approved', text: 'See you Sunday', edited: false }] }));
  assert.equal(g.calendar.length, 1);
  assert.deepEqual(plain(g.ctx.getPublic().events.map(e => e.id)), ['w7']);
  assert.throws(() => g.ctx.cancelEvent('wrong-code-1', 'w7', '', 'Jessie'), /organizer code/);
  assert.equal(cellOf(g, 'Events', 'w7', 'status'), 'published', 'nothing changed for a wrong code');

  const out = g.ctx.cancelEvent(CODE, 'w7', '  Heavy   rain is forecast  ', 'Jessie');
  assert.equal(out.message, "Cancelled. It's off the public site and the calendar. 2 cancellation notices are waiting for review in Outreach.");
  assert.equal(cellOf(g, 'Events', 'w7', 'status'), 'cancelled');
  assert.equal(cellOf(g, 'Events', 'w7', 'title'), 'OPC Garden Work Party', 'the rest of the row stays as it was');
  // the Calendar entry is deleted; its Posts row stays as the record that it was posted
  assert.deepEqual(g.calendar, [], 'the mock calendar entry is gone');
  const cal = postRowOf(g, 'w7', 'calendar');
  assert.deepEqual([cal.status, cal['calendar id'], cal.stale, cal['posted by']], ['posted', '', '', 'Phil']);
  // the Group and Partiful get a notice to approve and post; the Instagram draft goes
  const group = postRowOf(g, 'w7', 'ggroup'), pf = postRowOf(g, 'w7', 'partiful');
  assert.deepEqual([group.status, group.edited, group['posted by'], group['approved by']], ['review', 'yes', '', '']);
  assert.equal(group.text, 'Subject: Cancelled: OPC Garden Work Party on Sunday, October 25\n\nHi all,\n\n' + NOTICE + '\n\nThe East Bay Permaculture Guild');
  assert.deepEqual([pf.status, pf.text, pf.edited], ['review', NOTICE, 'yes']);
  assert.equal(postRowOf(g, 'w7', 'instagram'), undefined, 'the draft nobody posted is gone');
  assert.deepEqual(rowsFor(g, 'Activity', 'w7').slice(-3).map(r => r[2]),
    ['Jessie cancelled the event: Heavy rain is forecast', 'Took it off the Calendar', 'Drafted a cancellation notice for Partiful, Google Group email']);
  // the answer is the event as signIn reads it
  const e = plain(out.event);
  assert.deepEqual([e.cols.status, e.posts.ggroup.status, e.posts.partiful.text, e.posts.instagram], ['cancelled', 'review', NOTICE, undefined]);
  assert.equal(e.log.at(-3)[1], 'Jessie cancelled the event: Heavy rain is forecast');

  // the public page: not listed, and its id is there so the event's link can say it was cancelled
  const pub = plain(g.ctx.getPublic());
  assert.deepEqual([pub.events, pub.cancelled], [[], ['w7']]);
  // reminders: nothing for it tonight, nor in the morning
  const sent = g.mail.length;
  assert.equal(g.ctx.hourly(), 0);
  g.clock.now = new Date('2026-10-25T08:30:00-07:00').getTime();
  assert.equal(g.ctx.hourly(), 0);
  assert.equal(g.mail.length, sent, 'no reminders went out');
  // the Calendar can't get it back; the Group gets the notice once it's approved
  assert.throws(() => g.ctx.postTo(CODE, { ...ev(), cols: { ...ev().cols, status: 'cancelled' }, posts: [approved('calendar', 'x')] }, 'calendar', { by: 'Phil' }), /^Error: This event is cancelled, so it stays off the calendar\.$/);
  assert.equal(g.calendar.length, 0);
  g.ctx.postTo(CODE, { ...ev(), cols: { ...ev().cols, status: 'cancelled' }, posts: [{ ...approved('ggroup', group.text), edited: true }] }, 'ggroup', { by: 'Jessie' });
  assert.deepEqual([g.mail.at(-1).to, g.mail.at(-1).subject, g.mail.at(-1).body], ['ebpg@googlegroups.com', 'Cancelled: OPC Garden Work Party on Sunday, October 25', 'Hi all,\n\n' + NOTICE + '\n\nThe East Bay Permaculture Guild']);
  // pressed again: nothing more happens
  const lines = rowsFor(g, 'Activity', 'w7').length;
  assert.equal(g.ctx.cancelEvent(CODE, 'w7', 'again', 'Phil').message, 'This event was already cancelled.');
  assert.equal(rowsFor(g, 'Activity', 'w7').length, lines);
});

test("a tab that hasn't seen the cancel can save its edits, but the event stays cancelled and its notices and Activity stay", () => {
  const g = seeded({ now: BEFORE });
  g.ctx.postTo(CODE, toPost(), 'ggroup', { by: 'Phil' }); // test mode: Test sent
  g.ctx.cancelEvent(CODE, 'w7', '', 'Jessie');
  const notice = postRowOf(g, 'w7', 'ggroup');
  assert.equal(notice.text, 'Subject: Cancelled: OPC Garden Work Party on Sunday, October 25\n\nHi all,\n\nCancelled: OPC Garden Work Party on Sunday, October 25. Sorry for the change. We hope to see you at the next one.\n\nThe East Bay Permaculture Guild', 'no reason: no reason in it');
  const log = rowsFor(g, 'Activity', 'w7').map(r => r[2]);
  // the other tab still says published, with the Group approved and an old Activity
  g.ctx.saveEvent(CODE, toPost({ cols: { ...ev().cols, title: 'Work party (moved)', status: 'published' } }));
  assert.deepEqual([cellOf(g, 'Events', 'w7', 'status'), cellOf(g, 'Events', 'w7', 'title')], ['cancelled', 'Work party (moved)']);
  assert.deepEqual(postRowOf(g, 'w7', 'ggroup'), notice, 'the notice is not replaced by the old announcement');
  assert.deepEqual(rowsFor(g, 'Activity', 'w7').map(r => r[2]), log, 'the line saying who cancelled it stays');
  assert.deepEqual(plain(g.ctx.getPublic().events), []);
  // a page that knows it's cancelled saves its posts as usual
  g.ctx.saveEvent(CODE, ev({ cols: { ...ev().cols, status: 'cancelled' }, posts: [{ ...approved('ggroup', notice.text), edited: true }], log: [['Oct 24', 'Jessie approved Google Group email']] }));
  assert.deepEqual([postRowOf(g, 'w7', 'ggroup').status, rowsFor(g, 'Activity', 'w7').map(r => r[2])], ['approved', ['Jessie approved Google Group email']]);
});

test('Cancel event in test mode takes the [TEST] entry off the owner calendar, and says so', () => {
  const g = seeded({ now: BEFORE });
  g.ctx.postTo(CODE, toPost(), 'calendar', { by: 'Phil' });
  assert.equal(g.calendar[0].cal, 'default');
  const out = g.ctx.cancelEvent(CODE, 'w7', 'Rain', 'Phil');
  assert.equal(out.message, "Cancelled. It's off the public site and the calendar.");
  assert.deepEqual(g.calendar, []);
  assert.equal(postRowOf(g, 'w7', 'calendar').status, 'test');
  assert.deepEqual(rowsFor(g, 'Activity', 'w7').slice(-2).map(r => r[2]), ['Phil cancelled the event: Rain', "Took the [TEST] entry off the Sheet owner's calendar"]);
  assert.equal(postRowOf(g, 'w7', 'ggroup'), undefined, 'the Group draft nobody sent goes');
  // an event nobody was told about: just cancelled
  g.ctx.saveEvent(CODE, evAt('m2', '2026-11-12', { status: 'published' }));
  assert.equal(g.ctx.cancelEvent(CODE, 'm2', '', 'Phil').message, "Cancelled. It's off the public site.");
  assert.throws(() => g.ctx.cancelEvent(CODE, 'nope', '', 'Phil'), /^Error: This event was removed from the Sheet\.$/);
});

test('Delete draft: the row stays as a deleted tombstone, its Bringing, Posts and Activity rows go, and no read or save brings it back', () => {
  const g = seeded({ now: BEFORE });
  const draft = { ...evAt('n5', '2026-11-08', { status: 'draft' }), tasks: [{ id: 't9', what: 'Seeds', who: 'Phil', status: 'asked' }],
    posts: [{ channel: 'partiful', status: 'review', text: 'Seed swap', edited: false }], log: [['Oct 24', 'Phil created the event']] };
  g.ctx.saveEvent(CODE, draft);
  assert.deepEqual([rowsFor(g, 'Bringing', 'n5').length, rowsFor(g, 'Posts', 'n5').length, rowsFor(g, 'Activity', 'n5').length], [1, 1, 1]);
  assert.throws(() => g.ctx.deleteEvent('wrong-code-1', 'n5'), /organizer code/);
  assert.equal(g.ctx.deleteEvent(CODE, 'n5'), true);
  assert.equal(cellOf(g, 'Events', 'n5', 'status'), 'deleted');
  assert.equal(cellOf(g, 'Events', 'n5', 'title'), 'Event n5', 'the row is still there to read');
  assert.deepEqual([rowsFor(g, 'Bringing', 'n5').length, rowsFor(g, 'Posts', 'n5').length, rowsFor(g, 'Activity', 'n5').length], [0, 0, 0]);
  assert.equal(rowsFor(g, 'Bringing', 'w7').length, 3, "other events' rows stay");
  const st = plain(g.ctx.signIn(CODE));
  assert.deepEqual([st.events.map(e => e.cols.id), st.problems], [['w7'], []], 'signIn skips it, and it is not a problem to fix');
  assert.ok(!plain(g.ctx.getPublic()).cancelled.includes('n5'));
  // a tab still showing it can't bring it back, even as new
  const { created, ...later } = draft;
  for (const p of [later, draft]) assert.throws(() => g.ctx.saveEvent(CODE, p), /^Error: This event was removed from the Sheet\.$/);
  assert.throws(() => g.ctx.postTo(CODE, { ...later, posts: [approved('ggroup', 'Hi')] }, 'ggroup', { by: 'Phil' }), /removed from the Sheet/);
  assert.equal(rowsFor(g, 'Events', 'n5').length, 1);
  assert.deepEqual([cellOf(g, 'Events', 'n5', 'status'), rowsFor(g, 'Posts', 'n5').length, g.mail.length], ['deleted', 0, 0]);
  assert.throws(() => g.ctx.cancelEvent(CODE, 'n5', '', 'Phil'), /removed from the Sheet/);
  // deleting again, or an event never saved: nothing to do
  assert.equal(g.ctx.deleteEvent(CODE, 'n5'), true);
  const n = g.tab('Events').length;
  assert.equal(g.ctx.deleteEvent(CODE, 'n9999'), true);
  assert.equal(g.tab('Events').length, n, 'no row for an event the Sheet never had');
});

test('only a draft nobody outside has seen can be deleted: published once, or anything posted, means Cancel instead', () => {
  const g = seeded({ now: BEFORE });
  assert.throws(() => g.ctx.deleteEvent(CODE, 'w7'), /^Error: This event has been on the public site, so it can't be deleted\. Cancel it instead\.$/);
  assert.equal(cellOf(g, 'Events', 'w7', 'status'), 'published');
  // published, then made a draft again
  g.ctx.saveEvent(CODE, evAt('n6', '2026-11-08', { status: 'published' }));
  g.ctx.saveEvent(CODE, evAt('n6', '2026-11-08', { status: 'draft' }));
  assert.equal(plain(g.ctx.signIn(CODE)).events.find(e => e.cols.id === 'n6').data.wasPublished, true, 'the plan remembers it was published');
  assert.throws(() => g.ctx.deleteEvent(CODE, 'n6'), /Cancel it instead/);
  // a page that leaves the flag out can't clear it
  const { wasPublished, ...data } = evAt('n6', '2026-11-08').data;
  g.ctx.saveEvent(CODE, { ...evAt('n6', '2026-11-08', { status: 'draft' }), data });
  assert.throws(() => g.ctx.deleteEvent(CODE, 'n6'), /Cancel it instead/);
  // a draft with Partiful marked posted
  g.ctx.saveEvent(CODE, { ...evAt('n7', '2026-11-09', { status: 'draft' }), posts: [{ channel: 'partiful', status: 'posted', by: 'Phil', text: 'Hi', url: 'https://partiful.com/e/n7' }] });
  assert.throws(() => g.ctx.deleteEvent(CODE, 'n7'), /^Error: Something about this event was already posted, so it can't be deleted\. Cancel it instead\.$/);
  assert.deepEqual([cellOf(g, 'Events', 'n6', 'status'), cellOf(g, 'Events', 'n7', 'status')], ['draft', 'draft']);
  // a draft never published, with nothing posted, goes; through the JSON API too
  g.ctx.saveEvent(CODE, evAt('n8', '2026-11-10', { status: 'draft' }));
  assert.deepEqual(call(g, 'deleteEvent', [CODE, 'n8']), { value: true });
  assert.equal(cellOf(g, 'Events', 'n8', 'status'), 'deleted');
});

test('a save for an event whose row was taken out by hand is refused and adds nothing; created: true adds a new one', () => {
  const g = seeded({ now: BEFORE });
  // created: true (a new event's first save) adds the row; the saves after it leave created out and update it
  g.ctx.saveEvent(CODE, evAt('m2', '2026-11-12'));
  const { created, ...later } = evAt('m2', '2026-11-12', { title: 'Community Meeting' });
  g.ctx.saveEvent(CODE, later);
  assert.deepEqual(rowsFor(g, 'Events', 'm2').map(r => r[2]), ['Community Meeting'], 'one row, updated');
  // a second created: true (a retry after the Sheet's answer got lost) updates the same row
  g.ctx.saveEvent(CODE, { ...later, created: true });
  assert.equal(rowsFor(g, 'Events', 'm2').length, 1);
  // an id the Sheet never had, without created
  assert.throws(() => g.ctx.saveEvent(CODE, { ...later, id: 'zz9', data: { ...later.data, id: 'zz9' } }), /^Error: This event was removed from the Sheet\.$/);
  assert.equal(rowsFor(g, 'Events', 'zz9').length, 0);
  // the row's id cleared by hand (what /_set does on the dev server): a tab still showing it gets the words, and nothing is added
  setCell(g, 'Events', 'm2', 'id', '');
  const before = ['Events', 'Bringing', 'Posts', 'Activity'].map(t => g.tab(t).length);
  assert.deepEqual(call(g, 'saveEvent', [CODE, later]), { error: 'This event was removed from the Sheet.' });
  assert.throws(() => g.ctx.postTo(CODE, { ...later, posts: [approved('ggroup', 'Hi')] }, 'ggroup', { by: 'Phil' }), /removed from the Sheet/);
  assert.deepEqual(['Events', 'Bringing', 'Posts', 'Activity'].map(t => g.tab(t).length), before);
  assert.equal(rowsFor(g, 'Events', 'm2').length, 0, 'not added back');
  assert.equal(g.mail.length, 0, 'nothing posted');
  assert.deepEqual(plain(g.ctx.signIn(CODE)).events.map(e => e.cols.id), ['w7']);
  // seed adds its events as new, whether or not the page says so
  const s = gas();
  s.ctx.doGet({});
  s.ctx.seed(CODE, { events: [ev()], team });
  assert.equal(rowsFor(s, 'Events', 'w7').length, 1);
});
