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

test('first load makes every tab and the settings', () => {
  const g = gas();
  const out = g.ctx.doGet({ parameter: { ev: 'w7</script>' } });
  for (const t of ['Events', 'Bringing', 'Posts', 'Team', 'Volunteers', 'Activity', 'Gardens', 'Reminders', 'Settings']) assert.ok(g.sheets.get(t), t);
  assert.ok(!g.sheets.has('Sheet1'), 'blank default tab removed');
  assert.equal(g.tab('Settings').find(r => r[0] === 'TEST_MODE')[1], 'TRUE');
  assert.match(out.content, /window\.EBPG_GAS=/);
  assert.ok(!out.content.includes('w7</script>'), 'deep link is escaped');
  assert.equal(g.ctx.getPublic().events.length, 0);
  g.ctx.doGet({ parameter: {} });
  assert.equal(g.tab('Settings').length, 11, 'settings not duplicated on reload');
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
  const fresh = ev({ id: 'n1729', data: { id: 'n1729', photo: 'none', tags: [], plan: { roles: [['Host', ['Phil']]], notes: [], timeline: [] } },
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
  assert.deepEqual(head.slice(13), ['notes', 'Who to thank', 'timeline', "data (don't edit)"]);
  assert.equal(row[13], 'Bring gloves and hats');
  assert.equal(row[14], 'The OPC staff', 'the hand-added column is left alone');
  assert.equal(row[15], '10:00 AM Mulching');
  assert.equal(JSON.parse(row[16]).photo, 'moat');
  assert.equal(g.tab('Events').length, 2, 'saved in place, not added again');
  assert.equal(g.ctx.signIn(CODE).events[0].data.photo, 'moat');
});

test('a column added by hand to Settings or Gardens: settings and map points still go in the right cells', () => {
  const g = seeded();
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
  g.ctx.getPublic();
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
  g.ctx.saveEvent(CODE, ev({ id: 'm2', cols: { ...ev().cols, title: 'Meeting', date: '2026-11-12' }, tasks: [{ id: 't9', what: 'Notetaker', who: '', status: 'open' }], posts: [], log: [['Nov 1', 'Phil planned it']] }));
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
  g.ctx.saveEvent(CODE, ev({ id: 'm2', cols: { ...ev().cols, date: '2026-11-12' }, tasks: [], posts: [], log: [['Nov 1', 'Phil planned it']] }));
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
  const g = seeded();
  g.ctx.saveEvent(CODE, ev({ id: 'm2', cols: { ...ev().cols, title: 'Meeting', date: '2026-11-12' } }));
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
  assert.deepEqual(g.tab('Volunteers')[1], ['', '', 'the plant sale', '', '', ''], 'the hand-added column is kept');
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
  assert.equal(data.rsvp, undefined, 'an http: RSVP link is dropped');
  assert.deepEqual(data.tags, ['beginner', 'Bring a hat']);
  assert.equal(row[head.indexOf('tags')], 'beginner, Bring a hat');
  assert.equal(row[head.indexOf('title')].length, 200);
  assert.equal(row[head.indexOf('description')].length, 4000);
  assert.equal(row[head.indexOf('bring')].length, 500);
  assert.deepEqual([data.title.length, data.about.length], [200, 4000], "the plan's copies are capped too");
  assert.ok(!JSON.stringify(g.tab('Events')).includes('<script>'));

  g.ctx.saveEvent(CODE, ev({ data: { ...ev().data, photo: 'moat', map: 'https://maps.app.goo.gl/9jQkydC38eJrRScr6', rsvp: 'https://partiful.com/e/abc' } }));
  const ok = JSON.parse(g.tab('Events')[1][head.indexOf("data (don't edit)")]);
  assert.deepEqual([ok.photo, ok.map, ok.rsvp], ['moat', 'https://maps.app.goo.gl/9jQkydC38eJrRScr6', 'https://partiful.com/e/abc'], 'good values are kept');

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
  g.mailbox.fail = (to, subject) => /Welcome/.test(subject) && 'Invalid email: sam@example';
  assert.equal(g.ctx.addVolunteer({ name: 'Sam Lee', contact: 'sam@example', help: [], note: '' }), true);
  assert.equal(g.tab('Volunteers').length, 3);
  assert.deepEqual(g.tab('Reminders').slice(1).map(r => r.slice(1)), [['welcome', 'sam@example', 'failed: Invalid email: sam@example']]);
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
  const g = seeded();
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
  assert.deepEqual(plain(g.ctx.getPublic().events[0].posts), {});
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
