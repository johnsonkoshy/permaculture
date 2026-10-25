'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const partiful = require('../src/partiful.js');
const H = require('./helpers.js');
const { partifulPage, FAST } = require('./partiful-mock.js');

const text = (doc, sel) => doc.querySelector(sel).textContent.replace(/\s+/g, ' ').trim();
const kinds = res => res.filled.map(f => f.kind).sort();
const ALL = ['date', 'description', 'end', 'location', 'start', 'title'];
const run = (p, draft, opts) => partiful.fill(p.doc, draft, Object.assign({ timing: FAST }, opts || {}));
const nothingPublished = p => assert.ok(!p.clicks.some(c => /save-draft|login|publish/i.test(c)), 'never clicks Save draft, Publish or Login: ' + p.clicks.join(', '));

for (const layout of ['dialog', 'dropdown']) {
  test(`fills every part of Partiful's create page (${layout} date picker)`, async () => {
    const p = partifulPage({ layout });
    const draft = H.draft({ imageDataUrl: H.TINY_PNG });
    const res = await run(p, draft);
    assert.equal(res.mode, 'event');
    assert.deepEqual(kinds(res), ALL);
    assert.deepEqual(res.failed, []);
    assert.equal(res.image, 'attached');
    assert.equal(p.state.title, draft.title);
    assert.equal(p.state.description, draft.description);
    assert.deepEqual([p.state.date, p.state.start, p.state.end], ['2026-11-08', '10:00', '13:00']);
    assert.equal(text(p.doc, '[class*="EditableEventDate_eventDateContainer"] time'), 'Sunday, Nov 810:00am – 1:00pm');
    assert.equal(p.state.place.name, 'Oakland Peace Center');
    assert.match(text(p.doc, '#place'), /^Oakland Peace Center111 Fairmount Ave, Oakland, CA/);
    assert.equal(p.state.uploads, 1);
    assert.equal(p.doc.querySelectorAll('[role="dialog"]').length, 0, 'every dialog it opened is closed');
    assert.equal(p.doc.querySelector('[class*="EditableEventDate_dropdownWrapper"]'), null);
    nothingPublished(p);
  });
}

test('a time between the quarter hours is left for the person; the date still fills', async () => {
  const p = partifulPage();
  const res = await run(p, H.draft({ start: '10:10', end: '13:00' }));
  assert.ok(res.failed.includes('start'));
  assert.ok(kinds(res).includes('date'));
  assert.equal(p.state.date, '2026-11-08');
});

test('a day already gone (before today) is not picked', async () => {
  const p = partifulPage({ today: '2026-11-10' });
  const res = await run(p, H.draft());
  assert.deepEqual(res.failed.filter(k => ['date', 'start', 'end'].includes(k)).sort(), ['date', 'end', 'start']);
  assert.equal(p.state.date, '');
  assert.equal(p.doc.querySelectorAll('[role="dialog"]').length, 0, 'the date dialog was closed');
});

test('words the person already wrote stay unless Fill again', async () => {
  const p = partifulPage({ unsaved: 'My own title', saved: { description: 'My own notes' } });
  p.doc.querySelectorAll('[role="dialog"] button')[1].click();
  const draft = H.draft();
  let res = await run(p, draft, { withImage: false });
  assert.deepEqual(res.kept.sort(), ['description', 'title']);
  assert.equal(p.state.title, 'My own title');
  assert.equal(p.state.description, 'My own notes');
  res = await run(p, draft, { force: true, withImage: false });
  assert.equal(p.state.title, draft.title);
  assert.equal(p.state.description, draft.description);
  assert.ok(kinds(res).includes('title') && kinds(res).includes('description'));
});

test('a date that is already this one is left alone; a different one is kept', async () => {
  const p = partifulPage();
  await run(p, H.draft(), { withImage: false });
  const opened = p.state.pickerOpened;
  let res = await run(p, H.draft(), { withImage: false });
  assert.equal(p.state.pickerOpened, opened, 'did not open the picker again');
  assert.deepEqual(kinds(res), ALL);
  res = await run(p, H.draft({ date: '2026-11-15' }), { withImage: false });
  assert.deepEqual(res.kept.sort(), ['date', 'end', 'start']);
  assert.equal(p.state.date, '2026-11-08');
});

test('with no matching suggestion it uses the place exactly as typed', async () => {
  const p = partifulPage({ suggestions: [['Somewhere else', '9 Other St, Pontiac, MI, United States']] });
  const res = await run(p, H.draft(), { withImage: false });
  assert.ok(kinds(res).includes('location'));
  assert.equal(p.state.place.name, 'Oakland Peace Center, 111 Fairmount Ave, Oakland, CA 94611');
});

test('skipKind leaves parts alone, and an empty draft field is never touched', async () => {
  const p = partifulPage();
  const res = await run(p, H.draft({ place: '', address: '' }), { skipKind: k => k === 'title', withImage: false });
  assert.equal(p.state.title, '');
  assert.ok(!kinds(res).includes('title'));
  assert.ok(!kinds(res).includes('location') && !res.failed.includes('location'));
  assert.equal(p.state.place, null);
});

test('without the editor on the page it does nothing', async () => {
  const p = partifulPage({ lateMs: 200 });
  assert.equal(partiful.isEditor(p.doc), false);
  const res = await run(p, H.draft());
  assert.equal(res.mode, null);
  assert.deepEqual(res.filled, []);
});

test("Partiful's unsaved-event question: Keep editing only for this same event", async () => {
  const other = partifulPage({ unsaved: 'Somebody\'s birthday' });
  assert.ok(partiful.resumePrompt(other.doc));
  assert.equal(partiful.resumeOwn(other.doc, H.draft()), false);
  assert.ok(partiful.resumePrompt(other.doc), 'their own unsaved event waits for them');

  const same = partifulPage({ unsaved: H.draft().title, saved: { description: 'Earlier fill' } });
  assert.equal(partiful.resumeOwn(same.doc, H.draft()), true);
  assert.equal(partiful.resumePrompt(same.doc), null);
  assert.ok(partiful.isEditor(same.doc));
  assert.equal(same.state.title, H.draft().title);
});

test('day labels and times read the way Partiful writes them', () => {
  assert.equal(partiful.dayLabel('2026-10-31'), 'Saturday, October 31st, 2026');
  assert.equal(partiful.dayLabel('2026-11-02'), 'Monday, November 2nd, 2026');
  assert.equal(partiful.dayLabel('2026-11-13'), 'Friday, November 13th, 2026');
  assert.equal(partiful.wheelTime('13:00'), '1:00PM');
  assert.equal(partiful.wheelTime('00:15'), '12:15AM');
});

// ---- With the site script: how the helper runs the Partiful fill in a tab ----

const { createSiteHelper } = require('../src/site.js');

function helperOn(p, draft, opts) {
  const sent = [];
  const runtime = {
    id: 'ext', sent,
    sendMessage: async msg => { sent.push(msg); return msg.type === 'claim' ? { draft, channel: 'partiful', used: false } : { ok: true }; },
    onMessage: { addListener() {} }
  };
  const storage = H.storageArea({ draft: { channel: 'partiful', timestamp: Date.now(), draft } });
  const helper = createSiteHelper(Object.assign({ win: p.win, doc: p.doc, runtime, storage, watchMs: 300, debounceMs: 10, partifulTiming: FAST }, opts || {}));
  return { helper, sent };
}

async function until(test, ms) {
  const end = Date.now() + (ms || 3000);
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out');
    await H.tick(10);
  }
}

const panelMsg = helper => helper.state.panel.shadow.querySelector('.msg').textContent;

test('the site script fills Partiful once, and the page changing during the fill starts no second one', async () => {
  const p = partifulPage({ layout: 'dialog' });
  const { helper, sent } = helperOn(p, H.draft());
  await helper.start();
  await until(() => helper.state.filledKinds.size === 6);
  assert.match(panelMsg(helper), /^EBPG Posting Helper filled 6 fields\./);
  assert.equal(sent.filter(m => m.type === 'used').length, 1);
  assert.equal(p.state.pickerOpened, 1);
  // More changes on the page after the fill: still one run.
  p.doc.getElementById('root').appendChild(p.doc.createElement('div'));
  await H.tick(80);
  assert.equal(p.state.pickerOpened, 1);
  nothingPublished(p);
});

test('the site script waits for an editor that shows up late', async () => {
  const p = partifulPage({ lateMs: 120 });
  const { helper } = helperOn(p, H.draft());
  await helper.start();
  await until(() => helper.state.filledKinds.size === 6);
  assert.equal(p.state.title, H.draft().title);
});

test("Fill again runs the Partiful fill again and replaces what's there", async () => {
  const p = partifulPage();
  const { helper } = helperOn(p, H.draft());
  await helper.start();
  await until(() => helper.state.filledKinds.size === 6);
  p.state.title = 'Changed by hand';
  p.doc.querySelector('[class*="EditableEventTitle_titleInput"] span').textContent = 'Changed by hand';
  const res = await helper.fillAgain();
  assert.equal(res.mode, 'event');
  assert.equal(p.state.title, H.draft().title);
  assert.equal(helper.state.filledKinds.size, 6);
});

test("the site script leaves someone else's unsaved event for the person and fills once they choose", async () => {
  const p = partifulPage({ unsaved: "Somebody's birthday" });
  const { helper } = helperOn(p, H.draft(), { watchMs: 60 });
  await helper.start();
  await H.tick(200);
  assert.ok(partiful.resumePrompt(p.doc), 'did not answer for them');
  assert.equal(helper.state.watching, true, 'still watching past the usual time while Partiful waits for them');
  assert.match(panelMsg(helper), /looking for the form/);
  p.doc.querySelectorAll('[role="dialog"] button')[0].click();
  await until(() => helper.state.filledKinds.size === 6);
  assert.equal(p.state.title, H.draft().title);
});

test('the site script continues its own earlier fill (Keep editing) and fills what is missing', async () => {
  const p = partifulPage({ unsaved: H.draft().title, saved: { description: H.draft().description } });
  const { helper } = helperOn(p, H.draft());
  await helper.start();
  await until(() => helper.state.filledKinds.size === 6);
  assert.equal(p.state.title, H.draft().title);
  assert.equal(p.state.date, '2026-11-08');
});

// ---- What the review found: the person's own work stays theirs ----

test('a box the person has open and is typing in keeps their words unless Fill again', async () => {
  const p = partifulPage();
  const part = p.doc.querySelector('[class*="EditableEventDescription_input"]');
  part.focus();
  part.dispatchEvent(new p.win.FocusEvent('focusin', { bubbles: true }));
  const ta = part.querySelector('textarea');
  Object.getOwnPropertyDescriptor(p.win.HTMLTextAreaElement.prototype, 'value').set.call(ta, 'My own words being typed');
  ta.dispatchEvent(new p.win.Event('input', { bubbles: true }));
  const res = await run(p, H.draft(), { skipKind: k => k !== 'description', withImage: false });
  assert.deepEqual(res.kept, ['description']);
  assert.equal(ta.value, 'My own words being typed');
  assert.ok(ta.isConnected, 'left open for them');
});

test("a cover the person chose stays without Fill again; Partiful's stock poster is replaced", async () => {
  const own = partifulPage({ unsaved: H.draft().title, saved: { cover: 'https://partiful.imgix.net/external/user/mine.jpg' } });
  own.doc.querySelectorAll('[role="dialog"] button')[1].click();
  const draft = H.draft({ imageDataUrl: H.TINY_PNG });
  let res = await run(own, draft, { skipKind: k => k !== 'image' });
  assert.equal(res.image, 'kept');
  assert.equal(own.state.uploads, 0);
  res = await run(own, draft, { force: true, skipKind: k => k !== 'image' });
  assert.equal(res.image, 'attached');
  assert.equal(own.state.uploads, 1);
});

test('Fill again replaces a different place (Clear, then the search)', async () => {
  const p = partifulPage({ suggestions: [['Lake Merritt Garden', '666 Bellevue Ave, Oakland, CA 94610, United States']] });
  p.state.place = { name: 'Oakland Peace Center', line: '111 Fairmount Ave, Oakland, CA' };
  p.doc.getElementById('place').innerHTML = '<span>Oakland Peace Center</span><span>111 Fairmount Ave, Oakland, CA</span><span>(Optional) Location · hidden before rsvp</span>';
  const draft = H.draft({ place: 'Lake Merritt Garden', address: '666 Bellevue Ave, Oakland, CA 94610' });
  let res = await run(p, draft, { skipKind: k => k !== 'location', withImage: false });
  assert.deepEqual(res.kept, ['location'], 'without Fill again the other place stays');
  res = await run(p, draft, { force: true, skipKind: k => k !== 'location', withImage: false });
  assert.ok(kinds(res).includes('location'));
  assert.equal(p.state.place.name, 'Lake Merritt Garden');
  assert.equal(p.doc.querySelectorAll('[role="dialog"]').length, 0);
});

test("the site script doesn't fill someone else's event the person chose to keep editing; Fill again does", async () => {
  const p = partifulPage({ unsaved: "Somebody's birthday" });
  const { helper } = helperOn(p, H.draft());
  await helper.start();
  await H.tick(30);
  p.doc.querySelectorAll('[role="dialog"] button')[1].click();
  await H.tick(200);
  assert.equal(p.state.title, "Somebody's birthday");
  assert.equal(p.state.description, '');
  assert.equal(p.state.date, '');
  assert.equal(p.state.pickerOpened, 0);
  await helper.fillAgain();
  assert.equal(p.state.title, H.draft().title);
  assert.equal(p.state.date, '2026-11-08');
});

test('Fill again pressed during the automatic run runs right after it, with force', async () => {
  const p = partifulPage({ unsaved: H.draft().title, saved: { description: 'Typed by hand' } });
  const { helper } = helperOn(p, H.draft());
  await helper.start();
  await until(() => partiful.isEditor(p.doc));
  const res = await helper.fillAgain();
  assert.equal(res.mode, 'event');
  assert.equal(p.state.description, H.draft().description);
  assert.equal(helper.state.filledKinds.size, 6);
});

test('closing the panel stops the run: nothing more is opened or typed', async () => {
  const p = partifulPage();
  const { helper } = helperOn(p, H.draft({ imageDataUrl: H.TINY_PNG }));
  await helper.start();
  await until(() => p.state.title === H.draft().title || p.doc.querySelector('textarea'), 2000);
  helper.dismiss();
  await H.tick(600);
  assert.equal(p.state.pickerOpened, 0);
  assert.equal(p.state.place, null);
  assert.equal(p.state.uploads, 0);
  assert.equal(p.doc.querySelectorAll('[role="dialog"]').length, 0);
});
