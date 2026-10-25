'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const filler = require('../src/filler.js');
const H = require('./helpers.js');

function setup(name, url) {
  const d = H.dom(H.fixture(name), url);
  return { win: d.window, doc: d.window.document };
}

test('the React helper in these tests really ignores a plain value assignment', () => {
  const { win, doc } = setup('plain-create.html');
  const ta = doc.querySelector('textarea');
  const state = H.reactify(ta);
  ta.value = 'typed by a script';
  ta.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal(state.changes, 0, 'React would not see this change');
  filler.setInputValue(ta, 'Set the React way', win);
  assert.equal(state.value, 'Set the React way');
  assert.equal(state.changes, 1);
});

test('Partiful: fills title, location and description; leaves the date button alone', () => {
  const { win, doc } = setup('plain-create.html');
  H.addClipboardSupport(win);
  const fileInput = doc.querySelector('input[type=file]');
  H.allowFiles(fileInput);
  const title = H.reactify(doc.querySelector('textarea.title'));
  const loc = H.reactify(doc.querySelector('input[placeholder^="Place name"]'));
  const editor = doc.querySelector('[contenteditable]');
  const rich = H.richEditor(editor);
  let fileChanges = 0;
  fileInput.addEventListener('change', () => { fileChanges++; });
  const submits = H.watchSubmits(doc);

  const draft = H.draft({ imageDataUrl: H.TINY_PNG });
  const res = filler.fill(doc, draft, { channel: 'partiful', createPage: true });

  assert.equal(res.mode, 'event');
  assert.deepEqual(res.filled.map(f => f.kind).sort(), ['description', 'location', 'title']);
  assert.equal(title.value, draft.title);
  assert.equal(loc.value, 'Oakland Peace Center, 111 Fairmount Ave, Oakland, CA 94611');
  assert.equal(rich.pastes, 1, 'the description went in as a paste the editor handled');
  assert.match(editor.textContent, /sheet mulch the new beds/);
  assert.equal(doc.querySelector('input[name=capacity]').value, '', 'unrelated boxes stay empty');
  assert.equal(res.image, 'attached');
  assert.equal(fileInput.files.length, 1);
  assert.equal(fileInput.files[0].type, 'image/png');
  assert.equal(fileInput.files[0].name, 'workday-7-sheet-mulching-the-food-forest.png');
  assert.equal(fileChanges, 1);
  assert.deepEqual(submits, [], 'nothing was clicked or submitted');
});

test('Luma: unlabeled start/end date and time pairs, location search and ProseMirror description', () => {
  const { win, doc } = setup('luma-create.html', 'https://luma.com/create');
  const [d1, t1, d2, t2] = doc.querySelectorAll('.dt input');
  const states = [d1, t1, d2, t2].map(H.reactify);
  const submits = H.watchSubmits(doc);
  const res = filler.fill(doc, H.draft(), { channel: 'luma', createPage: true });
  assert.equal(res.mode, 'event');
  assert.equal(doc.querySelector('textarea').value, H.draft().title);
  assert.deepEqual(states.map(s => s.value), ['2026-11-08', '10:00', '2026-11-08', '13:00']);
  assert.equal(doc.querySelector('[role=combobox]').value, 'Oakland Peace Center, 111 Fairmount Ave, Oakland, CA 94611');
  assert.match(doc.querySelector('.ProseMirror').textContent, /Bring gloves/);
  assert.equal(doc.querySelector('nav input').value, '', 'the site search box is never touched');
  assert.equal(doc.querySelector('select').value, 'America/Los_Angeles', 'the time zone is left as is');
  assert.deepEqual(submits, []);
  assert.equal(win.document.activeElement === doc.querySelector('#create-event'), false);
});

test('Meetup: labeled fields, text date in the placeholder format, 12-hour time, end-time select', () => {
  const { win, doc } = setup('meetup-create.html', 'https://www.meetup.com/east-bay-permaculture/events/create/');
  const sel = doc.getElementById('endTime');
  for (let m = 0; m < 24 * 60; m += 30) {
    const o = doc.createElement('option');
    o.value = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const h = Math.floor(m / 60) % 12 || 12;
    o.textContent = `${h}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'AM' : 'PM'}`;
    sel.appendChild(o);
  }
  const title = H.reactify(doc.getElementById('title'));
  const submits = H.watchSubmits(doc);
  const res = filler.fill(doc, H.draft(), { channel: 'meetup', createPage: true });
  assert.equal(res.mode, 'event');
  assert.equal(title.value, H.draft().title);
  assert.equal(doc.getElementById('date').value, '11/08/2026');
  assert.equal(doc.getElementById('startTime').value, '10:00 AM');
  assert.equal(sel.value, '13:00');
  assert.equal(doc.getElementById('venue').value, 'Oakland Peace Center, 111 Fairmount Ave, Oakland, CA 94611');
  assert.equal(doc.getElementById('description').value, H.draft().description);
  assert.equal(doc.querySelector('header input').value, '', 'the header search is skipped');
  assert.equal(res.image, 'none', 'no image in the draft means nothing to upload');
  assert.deepEqual(submits, []);

  // With an image, it goes to the photo input that accepts PNG.
  H.addClipboardSupport(win);
  const photo = doc.getElementById('photo');
  H.allowFiles(photo);
  const again = filler.fill(doc, H.draft({ imageDataUrl: H.TINY_PNG }), { channel: 'meetup', createPage: true });
  assert.equal(again.image, 'attached');
  assert.equal(photo.files[0].type, 'image/png');
});

test('an image is not forced into a file input that refuses its type', () => {
  const d = H.dom('<form><label for=t>Title</label><input id=t><label for=w>Where</label><input id=w><input type=file accept="video/*"></form>');
  H.addClipboardSupport(d.window);
  const res = filler.fill(d.window.document, H.draft({ imageDataUrl: H.TINY_PNG }), { channel: 'partiful', createPage: true });
  assert.equal(res.image, 'no-field');
});

test('Facebook group: the post box gets the full text, the comment box and search stay empty', () => {
  const { win, doc } = setup('facebook-group.html', 'https://www.facebook.com/groups/ebpg');
  const res = filler.fill(doc, H.draft(), { channel: 'facebook' });
  assert.equal(res.mode, 'post');
  const box = doc.querySelector('[data-lexical-editor]');
  assert.match(box.textContent, /^Workday #7 is Sunday/);
  assert.equal(box.querySelectorAll('p').length, 4, 'each line became its own paragraph');
  assert.equal(doc.querySelector('[aria-label^="Write a comment"]').textContent, '');
  assert.equal(doc.querySelector('[role=banner] input').value, '');
  void win;
});

test('Facebook event form: dates follow the format already in the box, times use AM/PM', () => {
  const { doc } = setup('facebook-event.html', 'https://www.facebook.com/events/create/');
  const res = filler.fill(doc, H.draft(), { channel: 'facebook' });
  assert.equal(res.mode, 'event');
  const inputs = [...doc.querySelectorAll('[role=dialog] input')].map(i => i.value);
  assert.deepEqual(inputs, [H.draft().title, 'Nov 8, 2026', '10:00 AM', '11/08/2026', '1:00 PM', 'Oakland Peace Center, 111 Fairmount Ave, Oakland, CA 94611']);
  assert.equal(doc.querySelector('textarea').value, H.draft().description);
});

test('Hylo event: datetime-local start and end, TipTap description, location box', () => {
  const { doc } = setup('hylo-event.html', 'https://www.hylo.com/groups/ebpg/create/post');
  const res = filler.fill(doc, H.draft(), { channel: 'hylo', createPage: true });
  assert.equal(res.mode, 'event');
  assert.equal(doc.querySelector('input[name=title]').value, H.draft().title);
  const [s, e] = doc.querySelectorAll('input[type=datetime-local]');
  assert.equal(s.value, '2026-11-08T10:00');
  assert.equal(e.value, '2026-11-08T13:00');
  assert.match(doc.querySelector('.ProseMirror').textContent, /Bring gloves/);
  assert.equal(doc.querySelector('input[placeholder^="Where"]').value, 'Oakland Peace Center, 111 Fairmount Ave, Oakland, CA 94611');
  assert.equal(doc.querySelector('nav input').value, '');
});

test('a sign-in page in the opened tab is never filled', () => {
  const { doc } = setup('partiful-login.html', 'https://partiful.com/login?redirect=%2Fcreate');
  const submits = H.watchSubmits(doc);
  const res = filler.fill(doc, H.draft(), { channel: 'partiful', createPage: false });
  assert.equal(res.mode, null);
  assert.deepEqual(res.filled, []);
  assert.equal(doc.getElementById('nm').value, '');
  assert.deepEqual(submits, []);
});

test('without Fill again, words already typed in a text box are kept; with it they are replaced', () => {
  const { doc } = setup('meetup-create.html', 'https://www.meetup.com/x/events/create/');
  doc.getElementById('title').value = 'My own title';
  let res = filler.fill(doc, H.draft(), { channel: 'meetup', createPage: true });
  assert.ok(res.kept.includes('title'));
  assert.equal(doc.getElementById('title').value, 'My own title');
  res = filler.fill(doc, H.draft(), { channel: 'meetup', createPage: true, force: true });
  assert.equal(doc.getElementById('title').value, H.draft().title);
});

test('skip() leaves chosen fields alone', () => {
  const { doc } = setup('meetup-create.html', 'https://www.meetup.com/x/events/create/');
  const title = doc.getElementById('title');
  filler.fill(doc, H.draft(), { channel: 'meetup', createPage: true, skip: el => el === title });
  assert.equal(title.value, '');
  assert.equal(doc.getElementById('description').value, H.draft().description);
});

test('contenteditable without a rich editor falls back to beforeinput + input events', () => {
  const { win, doc } = setup('facebook-group.html', 'https://www.facebook.com/groups/ebpg');
  const box = doc.querySelector('[data-lexical-editor]');
  const seen = [];
  box.addEventListener('beforeinput', e => seen.push(e.type + ':' + e.inputType));
  box.addEventListener('input', e => seen.push(e.type + ':' + e.inputType));
  assert.ok(filler.setEditableValue(box, 'One line', win));
  assert.equal(box.textContent, 'One line');
  assert.deepEqual(seen, ['beforeinput:insertText', 'input:insertText']);
});

test('a hidden or disabled box is not a candidate', () => {
  const d = H.dom('<form><label for=a>Title</label><input id=a disabled><div style="display:none"><label for=b>Event name</label><input id=b></div><label for=c>Event title</label><input id=c></form>');
  const plan = filler.scan(d.window.document, { channel: 'partiful', createPage: true });
  assert.equal(plan.fields.get('title').id, 'c');
});

test('describe() reads labels, aria-labelledby, placeholders, names and nearby text', () => {
  const d = H.dom('<span id=l1>When does it start</span><div><div>Event name</div><input id=a name="event_name"></div><input id=b aria-labelledby="l1" placeholder="MM/DD/YYYY">');
  const doc = d.window.document;
  const a = filler.describe(doc.getElementById('a'));
  assert.equal(a.near, 'event name');
  assert.equal(a.attrs.includes('event name'), true);
  const b = filler.describe(doc.getElementById('b'));
  assert.equal(b.strong, 'when does it start');
  assert.equal(b.rawPlaceholder, 'mm/dd/yyyy');
});

test('the filler never clicks or submits anything (source check)', () => {
  const fs = require('fs');
  const path = require('path');
  for (const f of ['src/filler.js', 'src/site.js', 'src/panel.js']) {
    const src = fs.readFileSync(path.join(H.ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\.click\s*\(/, f);
    assert.doesNotMatch(src, /\.submit\s*\(|requestSubmit/, f);
  }
});

test('a rich editor is still recognized on Fill again after its placeholder is gone', () => {
  const { doc } = setup('hylo-event.html', 'https://www.hylo.com/groups/ebpg/create/post');
  const memory = new WeakMap();
  filler.fill(doc, H.draft(), { channel: 'hylo', createPage: true, memory });
  const editor = doc.querySelector('.ProseMirror');
  assert.equal(editor.querySelector('[data-placeholder]'), null, 'placeholder is gone once it holds text');
  editor.textContent = 'edited';
  const res = filler.fill(doc, H.draft(), { channel: 'hylo', createPage: true, force: true, memory });
  assert.ok(res.filled.some(f => f.kind === 'description'));
  assert.match(editor.textContent, /Bring gloves/);
});

test('Facebook group: the flyer goes to the composer, never to a cover-photo upload elsewhere on the page', () => {
  const html = H.fixture('facebook-group.html').replace('<div role="main">',
    '<div role="main">\n  <div class="cover-edit"><label>Edit cover photo<input type="file" accept="image/*" id="cover" style="display:none"></label></div>');
  const d = H.dom(html, 'https://www.facebook.com/groups/ebpg');
  const win = d.window, doc = win.document;
  H.addClipboardSupport(win);
  const cover = doc.getElementById('cover');
  const composer = doc.querySelector('[role=dialog] input[type=file]');
  [cover, composer].forEach(H.allowFiles);
  const changes = { cover: 0, composer: 0 };
  cover.addEventListener('change', () => { changes.cover++; });
  composer.addEventListener('change', () => { changes.composer++; });
  const res = filler.fill(doc, H.draft({ imageDataUrl: H.TINY_PNG }), { channel: 'facebook' });
  assert.equal(res.mode, 'post');
  assert.equal(res.image, 'attached');
  assert.equal(cover.files.length, 0, 'the cover photo input stays empty');
  assert.equal(composer.files.length, 1);
  assert.deepEqual(changes, { cover: 0, composer: 1 });
});

test('the image only goes to an upload box inside the form being filled', () => {
  const outside = H.dom('<main><div class="profile"><label>Profile picture<input type="file" accept="image/*" id="avatar"></label></div>' +
    '<div class="editor"><label for=t>Event title</label><input id=t><label for=w>Where</label><input id=w></div></main>');
  H.addClipboardSupport(outside.window);
  const avatar = outside.window.document.getElementById('avatar');
  H.allowFiles(avatar);
  const res = filler.fill(outside.window.document, H.draft({ imageDataUrl: H.TINY_PNG }), { channel: 'partiful', createPage: true });
  assert.equal(res.mode, 'event');
  assert.equal(res.image, 'no-field', 'an uploader outside the filled fields is left alone');
  assert.equal(avatar.files.length, 0);

  const inside = H.dom('<main><div class="editor"><input type="file" accept="image/*" id="flyer"><label for=t>Event title</label><input id=t>' +
    '<label for=w>Where</label><input id=w></div></main>');
  H.addClipboardSupport(inside.window);
  const flyer = inside.window.document.getElementById('flyer');
  H.allowFiles(flyer);
  const doc = inside.window.document;
  assert.equal(filler.formScope([doc.getElementById('t'), doc.getElementById('w')]), doc.querySelector('.editor'));
  assert.equal(filler.fill(doc, H.draft({ imageDataUrl: H.TINY_PNG }), { channel: 'partiful', createPage: true }).image, 'attached');
  assert.equal(flyer.files.length, 1);
});
