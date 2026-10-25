/*
 * EBPG Posting Helper: fills Partiful's create page, which has no ordinary form. Its title and
 * description turn into text boxes only when they get focus, and the date, the place and the
 * cover image each open a dialog of their own. This opens them one at a time, fills them in and
 * closes them, the way a person would. It never clicks Save draft, Publish or Login: people
 * review and publish.
 *
 * The page is read the way partiful.com/create showed it on 2026-10-25. If Partiful changes it,
 * a step that can't find its part says so (it lands in `failed`), the generic filler still runs
 * when the editor isn't there at all, and the panel's Copy buttons always work.
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const api = isNode ? factory(require('./shared.js'), require('./filler.js')) : factory(root.EBPG.shared, root.EBPG.filler);
  if (isNode) module.exports = api;
  else { root.EBPG = root.EBPG || {}; root.EBPG.partiful = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared, filler) {
  'use strict';

  // CSS-module class names keep their readable part; the hash after it changes with each release.
  const SEL = {
    title: '[class*="EditableEventTitle_titleInput"]',
    description: '[class*="EditableEventDescription_input"]',
    date: '[class*="EditableEventDate_eventDateContainer"]',
    image: '[class*="EditableEventImage_editButton"]',
    dialog: '[role="dialog"]'
  };
  // How long to wait for each thing (ms). Tests pass shorter ones.
  const TIMING = { step: 100, ready: 800, open: 3000, settle: 1000, suggest: 8000, save: 3000, upload: 20000 };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const squash = s => String(s || '').replace(/\s+/g, ' ').trim();
  // Text with no spaces at all: Partiful shows line breaks its own way, so compare without them.
  const bare = s => String(s || '').replace(/\s+/g, '');
  const textOf = el => squash(el && el.textContent);

  function isEditor(doc) {
    return !!(doc && doc.querySelector(SEL.title));
  }

  // ---------- Waiting and clicking ----------

  const sleep = (win, ms) => new Promise(ok => win.setTimeout(ok, ms));

  // Polls test() every T.step (times `slower`) for up to ms. Gives up at once when the run is
  // halted (the person closed the helper's panel).
  async function waitFor(win, test, ms, T, slower) {
    const end = Date.now() + ms;
    for (;;) {
      if (T.halted && T.halted()) return null;
      const v = test();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(win, T.step * (slower || 1));
    }
  }

  // A full mouse click: some of Partiful's parts listen for the press, others for the click.
  function press(el, win) {
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.left + 4, clientY: r.top + 4 };
    const P = typeof win.PointerEvent === 'function' ? win.PointerEvent : win.MouseEvent;
    el.dispatchEvent(new P('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, init)));
    el.dispatchEvent(new win.MouseEvent('mousedown', init));
    el.dispatchEvent(new P('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, init)));
    el.dispatchEvent(new win.MouseEvent('mouseup', init));
    el.click();
  }

  // Focus events are sent by hand as well: a tab in a window without focus never gets real ones.
  function focusIn(el, win) {
    try { el.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
    el.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
  }

  function focusOut(el, win) {
    try { el.blur(); } catch (e) { /* ignore */ }
    el.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
    el.dispatchEvent(new win.FocusEvent('blur'));
  }

  // Native setter, then input, so React takes the new value (without the blur setInputValue does).
  function typeInto(el, value, win) {
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    let v = value;
    if (el.maxLength > 0 && v.length > el.maxLength) v = v.slice(0, el.maxLength);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new (typeof win.InputEvent === 'function' ? win.InputEvent : win.Event)('input', { bubbles: true, inputType: 'insertReplacementText', data: v }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    return v;
  }

  const buttons = (root, re) => [...root.querySelectorAll('button')].filter(b => re.test(textOf(b)));

  // The open dialog that passes `test` (the cookie notice and anything else are left alone). Asked
  // for again each time: Partiful swaps in a new dialog element when a dialog moves to its next step.
  const dialogWhere = (doc, test) => [...doc.querySelectorAll(SEL.dialog)].find(test) || null;
  const dialogWith = (doc, part) => dialogWhere(doc, d => !!d.querySelector(part));

  // Close a dialog without saving it: its first button is Back or Close (a dialog with steps may
  // need it twice). find() gives the dialog as it is now, or null once it's gone.
  async function closeDialog(find, win, T) {
    for (let i = 0; i < 3; i++) {
      const dlg = find();
      if (!dlg) return;
      const first = dlg.querySelector('button');
      if (first) press(first, win);
      else dlg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await waitFor(win, () => find() !== dlg, T.settle, T);
    }
  }

  // ---------- Title and description ----------

  // Hint for finding the text box a part turns into, when focus isn't on it.
  const BOX_HINT = { title: /name|title/i, description: /description|details/i };

  function openBox(doc, kind) {
    const a = doc.activeElement;
    if (a && a.tagName === 'TEXTAREA') return a;
    const all = [...doc.querySelectorAll('textarea')];
    return all.find(t => BOX_HINT[kind].test(t.getAttribute('placeholder') || '')) || (all.length === 1 ? all[0] : null);
  }

  function isEmptyText(kind, el) {
    const shown = textOf(el);
    return !shown || /placeholder-shown/.test(String(el.className)) || (kind === 'title' && /^untitled event$/i.test(shown));
  }

  async function setText(doc, win, kind, value, o, T) {
    const part = doc.querySelector(SEL[kind]);
    if (!part) return { status: 'failed' };
    // A box that's already open is the person typing in it: its words are in .value, not the page text.
    const open = part.querySelector('textarea');
    if (open) {
      if (bare(open.value) === bare(value)) { focusOut(open, win); return { status: 'filled', el: part }; }
      if (open.value.trim() && !o.force) return { status: 'kept' };
    } else {
      if (bare(textOf(part)) === bare(value)) return { status: 'filled', el: part };
      if (!isEmptyText(kind, part) && !o.force) return { status: 'kept' };
    }
    focusIn(part, win);
    let box = await waitFor(win, () => openBox(doc, kind), T.settle / 2, T);
    if (!box) {
      press(part, win);
      box = await waitFor(win, () => openBox(doc, kind), T.open, T);
    }
    if (!box) return { status: 'failed' };
    const typed = typeInto(box, value, win);
    await sleep(win, T.step * 2);
    focusOut(box, win);
    const shown = await waitFor(win, () => {
      const now = doc.querySelector(SEL[kind]);
      return now && !now.querySelector('textarea') && bare(textOf(now)) === bare(typed) ? now : null;
    }, T.open, T);
    return shown ? { status: 'filled', el: shown } : { status: 'failed' };
  }

  // ---------- Date and times ----------
  // On a narrow window the picker is a dialog: the times are a wheel that takes whatever stops in
  // its middle, and Confirm saves. On a wide one it's a drop-down under the field: a time takes a
  // click, everything saves as it's picked, and a click outside closes it.

  const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

  function dateBits(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
  }

  // The day button's label: "Saturday, October 31st, 2026" (", selected" may follow).
  function dayLabel(iso) {
    const p = dateBits(iso);
    return `${DAYS[p.dow]}, ${MONTHS[p.m - 1]} ${ordinal(p.d)}, ${p.y}`;
  }

  // "10:00 AM" -> "10:00AM", the way the time list and the tab buttons write it.
  const wheelTime = hhmm => shared.time12(hhmm).replace(/\s+/g, '').toUpperCase();

  // An element's words with a space between its parts: Partiful puts "Nov 8" and "10:00am" in
  // separate elements with nothing between them, and textContent would run them together.
  function spaced(el) {
    if (!el) return '';
    const walk = el.ownerDocument.createTreeWalker(el, 4);
    const bits = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) bits.push(n.nodeValue);
    return squash(bits.join(' '));
  }

  // Whether an element shows a time ("1:00PM" must not match "11:00PM").
  const hasTime = (el, t) => new RegExp('(^|[^0-9:])' + t + '($|[^0-9A-Z])').test(spaced(el).replace(/(\d)\s*([ap])\.?m\b\.?/gi, '$1$2M').toUpperCase());

  const before = (a, b) => !!(a.compareDocumentPosition(b) & 4);

  // The open picker, asked for again each time (Partiful redraws it as things are picked).
  function datePicker(doc) {
    const grid = doc.querySelector('[role="grid"]');
    return grid ? grid.closest('[role="dialog"], [role="popover"], [class*="EditableEventDate_eventDatePopover"]') : null;
  }

  // Start and end tabs: the buttons with words in them above the calendar, except Clear.
  function dateTabs(pick) {
    const grid = pick.querySelector('[role="grid"]');
    return [...pick.querySelectorAll('button')].filter(b => (!grid || before(b, grid)) && textOf(b) && !/^clear$/i.test(textOf(b)));
  }

  function findDay(pick, label) {
    return [...pick.querySelectorAll('button[aria-label]')].find(b => b.getAttribute('aria-label').includes(label)) || null;
  }

  const timeItems = pick => [...pick.querySelectorAll('[data-time], span[tabindex]')].filter(i => /^\d{1,2}:\d{2}[AP]M$/.test(bare(textOf(i)).toUpperCase()));

  // Move the calendar to the event's month with its arrow buttons (the last two icon buttons above it).
  async function showMonth(doc, iso, win, T) {
    const want = dateBits(iso);
    for (let i = 0; i < 36; i++) {
      const pick = datePicker(doc);
      if (!pick) return false;
      if (findDay(pick, dayLabel(iso))) return true;
      const cap = pick.querySelector('.rdp-caption_label, [role="status"]');
      const m = /([A-Za-z]+)\s+(\d{4})/.exec(textOf(cap));
      if (!m) return false;
      const shownAt = Number(m[2]) * 12 + MONTHS.indexOf(m[1]);
      const wantAt = want.y * 12 + want.m - 1;
      if (shownAt === wantAt) return false;
      const grid = pick.querySelector('[role="grid"]');
      const arrows = [...pick.querySelectorAll('button')].filter(b => !textOf(b) && (!grid || before(b, grid))).slice(-2);
      const arrow = arrows[wantAt > shownAt ? 1 : 0];
      if (!arrow || arrow.disabled) return false;
      const was = textOf(cap);
      press(arrow, win);
      if (!await waitFor(win, () => { const p = datePicker(doc); const c = p && p.querySelector('.rdp-caption_label, [role="status"]'); return c && textOf(c) !== was; }, T.open, T)) return false;
    }
    return false;
  }

  function scrollerOf(el, pick, win) {
    for (let p = el.parentElement; p && p !== pick; p = p.parentElement) {
      if (/(auto|scroll)/.test(win.getComputedStyle(p).overflowY)) return p;
    }
    return null;
  }

  // Sets the time on tab `which` (0 start, 1 end): a click for the list, a scroll for the wheel.
  async function setTime(doc, which, hhmm, win, T) {
    const t = wheelTime(hhmm);
    const shows = () => { const p = datePicker(doc); const tab = p && dateTabs(p)[which]; return !!tab && hasTime(tab, t); };
    if (shows()) return true;
    const item = await waitFor(win, () => { const p = datePicker(doc); return p && timeItems(p).find(i => bare(textOf(i)).toUpperCase() === t); }, T.open, T);
    if (!item) return false;
    press(item, win);
    if (await waitFor(win, shows, T.settle / 2, T)) return true;
    const sc = scrollerOf(item, datePicker(doc), win);
    if (!sc) return false;
    for (let i = 0; i < 2; i++) {
      const ir = item.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      sc.scrollTop = sc.scrollTop + (ir.top + ir.height / 2) - (sr.top + sr.height / 2);
      sc.dispatchEvent(new win.Event('scroll'));
      if (await waitFor(win, shows, T.settle, T)) return true;
    }
    return false;
  }

  // A click on the page outside the drop-down closes it.
  function clickOutside(doc, win) {
    const init = { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 };
    const P = typeof win.PointerEvent === 'function' ? win.PointerEvent : win.MouseEvent;
    doc.body.dispatchEvent(new P('pointerdown', init));
    doc.body.dispatchEvent(new win.MouseEvent('mousedown', init));
    doc.body.dispatchEvent(new P('pointerup', init));
    doc.body.dispatchEvent(new win.MouseEvent('mouseup', init));
    doc.body.dispatchEvent(new win.MouseEvent('click', init));
  }

  // The dialog closes without saving (its Back button); the drop-down keeps what was picked.
  async function closePicker(doc, win, T) {
    const pick = datePicker(doc);
    if (!pick) return;
    if (pick.closest('[role="dialog"]')) return closeDialog(() => datePicker(doc), win, T);
    clickOutside(doc, win);
    await waitFor(win, () => !datePicker(doc), T.settle, T);
  }

  async function setDate(doc, win, draft, o, T, out) {
    const kinds = ['date'].concat(draft.start ? ['start'] : [], draft.end ? ['end'] : []);
    const fail = list => list.forEach(k => out.failed.push(k));
    const box = doc.querySelector(SEL.date);
    if (!box) return fail(kinds);
    const p = dateBits(draft.date);
    const shortDay = new RegExp(`\\b${MONTHS[p.m - 1].slice(0, 3)} ${p.d}\\b`);
    // What the field shows for each part: "Sunday, Nov 8 10:00am – 1:00pm".
    const shown = el => ({
      date: shortDay.test(spaced(el)),
      start: !!draft.start && hasTime(el, wheelTime(draft.start)),
      end: !!draft.end && hasTime(el, wheelTime(draft.end))
    });
    const already = shown(box);
    if (kinds.every(k => already[k]) && !o.force) { kinds.forEach(k => out.filled.push({ kind: k, el: box })); return; }
    if (!/set a date/i.test(textOf(box)) && !o.force) { kinds.forEach(k => out.kept.push(k)); return; }
    // The click has to land inside: the box itself doesn't open anything.
    const leaf = box.querySelector('time') || [...box.querySelectorAll('*')].find(e => !e.children.length && /set a date/i.test(textOf(e))) || box.firstElementChild || box;
    press(leaf, win);
    if (!await waitFor(win, () => datePicker(doc), T.open, T)) return fail(kinds);
    try {
      if (!await showMonth(doc, draft.date, win, T)) return fail(kinds);
      const day = findDay(datePicker(doc), dayLabel(draft.date));
      if (!day || day.disabled) return fail(kinds);
      if (!/selected/i.test(day.getAttribute('aria-label'))) press(day, win);
      await sleep(win, T.settle / 2);
      // The drop-down moves on to the end time by itself once a day is picked: go back to the start.
      const startTab = datePicker(doc) && dateTabs(datePicker(doc))[0];
      if (startTab && !startTab.disabled) press(startTab, win);
      if (draft.start) await setTime(doc, 0, draft.start, win, T);
      if (draft.end) {
        const endTab = datePicker(doc) && dateTabs(datePicker(doc))[1];
        if (endTab && !endTab.disabled) {
          press(endTab, win);
          await sleep(win, T.settle / 2);
          // The end tab picks the same day; pick it if it didn't.
          const endDay = datePicker(doc) && findDay(datePicker(doc), dayLabel(draft.date));
          if (endDay && !/selected/i.test(endDay.getAttribute('aria-label'))) press(endDay, win);
          await setTime(doc, 1, draft.end, win, T);
        }
      }
      const pick = datePicker(doc);
      const confirm = pick && buttons(pick, /^confirm$/i)[0];
      if (confirm) press(confirm, win);
      else if (pick) clickOutside(doc, win);
      await waitFor(win, () => !datePicker(doc), T.open, T);
    } finally {
      await closePicker(doc, win, T);
    }
    const now = doc.querySelector(SEL.date) || box;
    const got = shown(now);
    kinds.forEach(k => { if (got[k]) out.filled.push({ kind: k, el: now }); else out.failed.push(k); });
  }

  // ---------- Place ----------

  // The place row: "Location" when empty, else the place, both with Partiful's "Location · hidden before rsvp" note.
  function placeButton(doc) {
    return [...doc.querySelectorAll('[role="button"]')].find(b => /^location\b/i.test(textOf(b)))
      || [...doc.querySelectorAll('[role="button"]')].find(b => /location\s*·\s*hidden/i.test(textOf(b))) || null;
  }
  const placeEmpty = b => /^location\b/i.test(textOf(b));

  // The smallest part of the dialog whose text passes `test`: the suggestion row, not the whole list.
  function smallest(dlg, test) {
    const hits = [...dlg.querySelectorAll('div, li, button, [role="option"]')].filter(e => !e.querySelector('input') && test(textOf(e).toLowerCase()));
    return hits.filter(e => !hits.some(h => h !== e && e.contains(h)))[0] || null;
  }

  async function setPlace(doc, win, draft, o, T) {
    const name = squash(draft.place).toLowerCase();
    const address = squash(draft.address);
    const line = shared.placeLine(draft.place, draft.address);
    const key = (name || address.split(',')[0]).toLowerCase();
    const shownHere = () => [...doc.querySelectorAll('[role="button"]')].find(b => !placeEmpty(b) && textOf(b).toLowerCase().includes(key));
    let trigger = placeButton(doc);
    if (!trigger || !placeEmpty(trigger)) {
      const shown = shownHere();
      if (shown) return { status: 'filled', el: shown };
      if (!trigger || !o.force) return { status: trigger ? 'kept' : 'failed' };
      // Fill again over another place: Clear in its dialog empties it, then it's filled as new.
      press(trigger, win);
      const clear = await waitFor(win, () => { const d = dialogWhere(doc, x => buttons(x, /^clear$/i).length > 0); return d && buttons(d, /^clear$/i)[0]; }, T.open, T);
      if (!clear) { await closeDialog(() => dialogWhere(doc, x => buttons(x, /^save$/i).length > 0), win, T); return { status: 'failed' }; }
      press(clear, win);
      trigger = await waitFor(win, () => { const b = placeButton(doc); return b && placeEmpty(b) && !dialogWhere(doc, x => buttons(x, /^clear$/i).length > 0) ? b : null; }, T.open, T);
      if (!trigger) return { status: 'failed' };
    }
    press(trigger, win);
    const search = 'input[type="search"], input[placeholder^="Place name"]';
    // Its first step has the search box; its second, Save.
    const placeDialog = () => dialogWhere(doc, d => !!d.querySelector(search) || buttons(d, /^save$/i).length > 0);
    const dlg = await waitFor(win, () => dialogWith(doc, search), T.open, T);
    if (!dlg) return { status: 'failed' };
    try {
      const input = dlg.querySelector(search);
      focusIn(input, win);
      typeInto(input, line, win);
      // Partiful's own suggestion keeps the map pin; "Use ..." keeps the words exactly as typed.
      const num = (/^\s*(\d+)\b/.exec(address) || [])[1];
      const match = t => !/^use "/.test(t) && t.includes(key) && (!num || t.includes(num));
      const pick = await waitFor(win, () => smallest(dlg, match), T.suggest, T, 2)
        || smallest(dlg, t => /^use "/.test(t));
      if (!pick) return { status: 'failed' };
      press(pick, win);
      // A second step asks for a display name and an apartment number, then Save. Save does
      // nothing until that step has loaded the place, so wait for it, and press again if needed.
      for (let i = 0; i < 2 && placeDialog(); i++) {
        const save = await waitFor(win, () => {
          const d = placeDialog();
          if (!d) return null;
          const b = buttons(d, /^save$/i)[0];
          return b && !b.disabled && !d.querySelector(search) && textOf(d).toLowerCase().includes(key) ? b : null;
        }, T.save, T);
        if (!save) break;
        await sleep(win, T.step * 3);
        press(save, win);
        await waitFor(win, () => !placeDialog(), T.save, T);
      }
      const shown = await waitFor(win, () => !placeDialog() && shownHere(), T.open, T);
      return shown ? { status: 'filled', el: shown } : { status: 'failed' };
    } finally {
      await closeDialog(placeDialog, win, T);
    }
  }

  // ---------- Cover image ----------

  async function setImage(doc, win, draft, force, T) {
    const type = (/^data:(image\/[a-z]+);/.exec(draft.imageDataUrl) || [])[1];
    const edit = doc.querySelector(SEL.image);
    if (!edit) return 'no-field';
    const cover = () => { const img = doc.querySelector('[class*="EditableEventImage"] img'); return img ? img.getAttribute('src') : ''; };
    const was = cover();
    // Without Fill again, a cover the person (or an earlier fill) put there stays.
    if (!force && was && !/^https:\/\/partiful-posters\./.test(was)) return 'kept';
    press(edit, win);
    const upload = () => dialogWith(doc, 'input[type="file"]');
    const dlg = await waitFor(win, upload, T.open, T);
    if (!dlg) return 'no-field';
    const input = filler.findImageInput(dlg, type);
    if (!input) { await closeDialog(upload, win, T); return 'no-field'; }
    // Partiful empties the file box as soon as it has the file, so attachImage's own answer can't
    // be trusted here: the dialog closing and the cover changing are what show it worked.
    filler.attachImage(input, draft, win);
    const ok = await waitFor(win, () => !upload() && cover() !== was, T.upload, T, 2);
    if (!ok) await closeDialog(upload, win, T);
    return ok ? 'attached' : 'failed';
  }

  // ---------- "We found an unsaved event!" ----------

  // Partiful keeps an unsaved event in the browser and, on the next visit, asks about it before
  // showing the editor: Continue editing "<title>"? Start fresh / Keep editing.
  function resumePrompt(doc) {
    return dialogWhere(doc, d => buttons(d, /^keep editing$/i).length > 0 && buttons(d, /^start fresh$/i).length > 0);
  }

  /*
   * When the unsaved event is this one (an earlier fill), Keep editing: it carries on where that
   * left off. Any other unsaved event is the person's own work, so they choose, and the helper
   * fills once the editor shows. Returns true when it pressed Keep editing.
   */
  function resumeOwn(doc, draft) {
    const d = resumePrompt(doc);
    if (!d || !draft) return false;
    const quoted = /["“]([^"”]+)["”]/.exec(textOf(d));
    if (!quoted || squash(quoted[1]).toLowerCase() !== squash(draft.title).toLowerCase()) return false;
    press(buttons(d, /^keep editing$/i)[0], doc.defaultView);
    return true;
  }

  // An editor that already holds another event (the person chose Keep editing on their own
  // unsaved event): it isn't filled by itself, only with Fill again.
  function holdsOther(doc, draft) {
    const part = doc.querySelector(SEL.title);
    if (!part || !draft) return false;
    const open = part.querySelector('textarea');
    const shown = open ? squash(open.value) : textOf(part);
    return !isEmptyText('title', part) && !!shown && shown.toLowerCase() !== squash(draft.title).toLowerCase();
  }

  // ---------- The whole fill ----------

  /*
   * Fills Partiful's create page. Options:
   *   force        true for "Fill again": replace what is there
   *   skipKind(k)  return true to leave a part alone (filled earlier in this tab)
   *   withImage    false to leave the cover image alone
   *   halted()     return true to stop: it stops waiting, closes what it opened and does nothing more
   *   timing       shorter waits, for tests
   * Returns { mode, filled: [{kind, el}], failed: [kind], kept: [kind], image } like filler.fill.
   */
  async function fill(doc, draft, opts) {
    const o = opts || {};
    const T = Object.assign({}, TIMING, o.timing || {}, { halted: o.halted || null });
    const win = doc.defaultView;
    const out = { mode: null, filled: [], failed: [], kept: [], image: 'none' };
    if (!draft || !isEditor(doc)) return out;
    out.mode = 'event';
    // Let the page finish drawing before opening anything.
    await sleep(win, T.ready);
    const want = k => !(o.skipKind && o.skipKind(k)) && !(T.halted && T.halted());
    const note = (kind, r) => {
      if (r.status === 'filled') out.filled.push({ kind, el: r.el });
      else if (r.status === 'kept') out.kept.push(kind);
      else out.failed.push(kind);
    };
    const step = async (kinds, run) => {
      try { await run(); } catch (e) { kinds.forEach(k => { if (!out.filled.some(f => f.kind === k)) out.failed.push(k); }); }
    };
    if (draft.title && want('title')) await step(['title'], async () => note('title', await setText(doc, win, 'title', draft.title, o, T)));
    const desc = draft.description || draft.text;
    if (desc && want('description')) await step(['description'], async () => note('description', await setText(doc, win, 'description', desc, o, T)));
    if (draft.date && ['date', 'start', 'end'].some(want)) await step(['date', 'start', 'end'], () => setDate(doc, win, draft, o, T, out));
    if ((draft.place || draft.address) && want('location')) await step(['location'], async () => note('location', await setPlace(doc, win, draft, o, T)));
    if (draft.imageDataUrl && o.withImage !== false && !(T.halted && T.halted())) {
      try { out.image = await setImage(doc, win, draft, !!o.force, T); } catch (e) { out.image = 'failed'; }
    }
    return out;
  }

  return { SEL, TIMING, isEditor, holdsOther, resumePrompt, resumeOwn, fill, dayLabel, wheelTime };
});
