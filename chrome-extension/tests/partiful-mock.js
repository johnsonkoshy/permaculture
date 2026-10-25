'use strict';
/*
 * A stand-in for partiful.com/create's own code, on tests/fixtures/partiful-create.html. It does
 * what the live page did on 2026-10-25:
 *   - title and description: text that becomes a <textarea> on focus and takes the typed value
 *     (only through input events, like React) when it loses focus
 *   - date: a dialog on a narrow window (the times are a wheel that takes whatever stops in its
 *     middle; clicking a time does nothing; Confirm saves, Back throws it away), or a drop-down
 *     on a wide one (a time takes a click, everything saves as it's picked, a click outside closes)
 *   - place: a dialog with a search box and suggestions; picking one swaps in a new dialog whose
 *     Save does nothing until it has loaded the place
 *   - cover image: an Upload dialog; the file box is emptied as soon as it has the file
 *   - "We found an unsaved event!" before the editor, when there is one
 */
const H = require('./helpers.js');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const parts = iso => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }; };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const label12 = hhmm => { let [h, m] = hhmm.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')}${ap}`; };
const plus = (hhmm, mins) => { const t = Math.min(23 * 60 + 45, hhmm.split(':').map(Number).reduce((h, m) => h * 60 + m) + mins); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const SLOTS = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);
const ROW = 20, WHEEL = 200;

/*
 * opts:
 *   layout       'dialog' (narrow window) or 'dropdown' (wide window)
 *   today        the first day that can be picked
 *   unsaved      the title of an unsaved event Partiful asks about first (with `saved`, what it holds)
 *   suggestions  [[name, address line]] the place search offers
 *   lateMs       draw the editor this late
 */
function partifulPage(opts) {
  const o = Object.assign({ layout: 'dialog', today: '2026-10-25', unsaved: null, saved: {}, lateMs: 0,
    suggestions: [['Oakland Peace Center', '111 Fairmount Ave, Oakland, CA 94611, United States'], ['111 Fairmount Ave', 'Oakland, CA, United States']] }, opts || {});
  const d = H.dom(H.fixture('partiful-create.html'), 'https://partiful.com/create');
  const win = d.window, doc = win.document;
  H.addClipboardSupport(win);
  const clicks = H.watchSubmits(doc);
  const state = { title: '', description: '', date: '', start: '', end: '', place: null, cover: '', uploads: 0, pickerOpened: 0 };
  const el = (html) => { const t = doc.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const later = (ms, fn) => win.setTimeout(fn, ms);

  // ---- the editor ----

  function mount(saved) {
    const editor = doc.getElementById('editor').content.cloneNode(true);
    doc.getElementById('root').replaceChildren(editor);
    Object.assign(state, saved || {});
    if (state.cover) doc.querySelector('[class*="EditableEventImage"] img').setAttribute('src', state.cover);
    state.cover = doc.querySelector('[class*="EditableEventImage"] img').getAttribute('src');
    textPart('title', '[class*="EditableEventTitle_titleInput"]', 'Untitled Event', '*Name your event');
    textPart('description', '[class*="EditableEventDescription_input"]', 'Add a description of your event', 'Add a description of your event');
    drawDate();
    doc.querySelector('[class*="EditableEventDate_eventDateContainer"] time').addEventListener('click', openDate);
    drawPlace();
    doc.getElementById('place').addEventListener('click', openPlace);
    doc.querySelector('[class*="EditableEventImage_editButton"]').addEventListener('click', openUpload);
  }

  function textPart(kind, sel, empty, placeholder) {
    const part = doc.querySelector(sel);
    const show = () => {
      const span = doc.createElement('span');
      span.textContent = state[kind] || empty;
      part.replaceChildren(span);
      part.classList.toggle('placeholder-shown', !state[kind] && kind !== 'title');
    };
    show();
    part.addEventListener('focusin', () => {
      if (part.querySelector('textarea')) return;
      const ta = doc.createElement('textarea');
      ta.setAttribute('placeholder', placeholder);
      ta.value = state[kind];
      const typed = H.reactify(ta);
      part.replaceChildren(ta);
      ta.focus();
      ta.addEventListener('focusout', () => {
        if (!ta.isConnected) return;
        state[kind] = typed.value.trim();
        show();
      });
    });
  }

  // ---- date ----

  const fieldDate = () => {
    if (!state.date) return 'Set a date...';
    const p = parts(state.date);
    const t = h => label12(h).toLowerCase();
    return `<div>${DAYS[p.dow]}, ${MONTHS[p.m - 1].slice(0, 3)} ${p.d}</div><div>${t(state.start)} – ${t(state.end)}</div>`;
  };

  function drawDate() {
    const time = doc.querySelector('[class*="EditableEventDate_eventDateContainer"] time');
    time.innerHTML = state.date ? fieldDate() : '<div><div><div>Set a date...</div></div></div>';
  }

  let picker = null;
  function openDate() {
    if (picker) return;
    state.pickerOpened++;
    const before = { date: state.date, start: state.start, end: state.end };
    const p = parts(state.date || o.today);
    const ui = { year: p.y, month: p.m, tab: 'start', before };
    if (o.layout === 'dialog') {
      picker = el('<div role="dialog" class="legacy-modal-overlay"><div class="sheet"></div></div>');
      doc.body.appendChild(picker);
    } else {
      picker = el('<span role="popover" class="EditableEventDate_dropdownWrapper__ybRWL"><div class="EditableEventDate_eventDatePopover__R1l1Z"></div></span>');
      doc.querySelector('[class*="EditableEventDate_eventDateContainer"]').after(picker);
      later(0, () => doc.addEventListener('mousedown', outside, true));
    }
    picker.ui = ui;
    drawPicker();
  }

  function closeDate(keep) {
    if (!picker) return;
    if (!keep) Object.assign(state, picker.ui.before);
    doc.removeEventListener('mousedown', outside, true);
    picker.remove();
    picker = null;
    drawDate();
  }

  function outside(e) {
    if (picker && !picker.contains(e.target)) closeDate(true);
  }

  function pickDay(day) {
    const ui = picker.ui;
    if (ui.tab === 'end') { drawPicker(); return; }
    state.date = day;
    if (!state.start) state.start = '19:00';
    state.end = plus(state.start, 180);
    if (o.layout === 'dropdown') { ui.tab = 'end'; drawDate(); }
    drawPicker();
  }

  function pickTime(hhmm) {
    if (picker.ui.tab === 'start') { state.start = hhmm; state.end = plus(hhmm, 180); }
    else state.end = hhmm;
    if (o.layout === 'dropdown') drawDate();
    drawPicker();
  }

  function drawPicker() {
    const ui = picker.ui, wide = o.layout === 'dropdown';
    const box = picker.firstElementChild;
    const first = new Date(Date.UTC(ui.year, ui.month - 1, 1)).getUTCDay();
    const days = new Date(Date.UTC(ui.year, ui.month, 0)).getUTCDate();
    const t = parts(o.today);
    const atToday = ui.year === t.y && ui.month === t.m;
    const tabText = (which) => {
      const hhmm = which === 'start' ? state.start : state.end;
      if (!state.date || (which === 'end' && !ui.endShown && !wide)) return which === 'start' ? 'Start Date' : '<span>Optional</span><span>End Date</span>';
      const p = parts(state.date);
      return `<span>${DAYS[p.dow].slice(0, 3)}, ${MONTHS[p.m - 1].slice(0, 3)} ${ordinal(p.d)}</span><span>${label12(hhmm)}</span>`;
    };
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<td role="gridcell" class="rdp-hidden"></td>';
    for (let n = 1; n <= days; n++) {
      const day = iso(ui.year, ui.month, n), p = parts(day);
      const label = `${DAYS[p.dow]}, ${MONTHS[p.m - 1]} ${ordinal(n)}, ${p.y}${state.date === day ? ', selected' : ''}`;
      cells += `<td role="gridcell"><button type="button" tabindex="-1" aria-label="${label}"${day < o.today ? ' disabled' : ''} data-day="${day}">${n}</button></td>`;
    }
    const list = ui.tab === 'end' ? SLOTS.filter(s => s > state.start) : SLOTS;
    const times = state.date || wide
      ? `<div class="wheel" style="overflow-y: scroll">${list.map(s => `<span${ui.tab === 'start' || !wide ? ` data-time="${s}"` : ''} tabindex="0">${label12(s)}</span>`).join('')}</div>`
      : '<div>Start Time</div>';
    box.innerHTML = (wide ? '' : '<button type="button" class="back"><svg></svg></button><span>Date &amp; Time</span><button type="button">Clear</button>')
      + `<button type="button" class="tab start">${tabText('start')}</button>`
      + (wide ? '' : '<button type="button" class="arrow"><svg></svg></button>')
      + `<button type="button" class="tab end"${wide && !state.date ? ' disabled' : ''}>${tabText('end')}</button>`
      + `<div><span class="rdp-caption_label" role="status">${MONTHS[ui.month - 1]} ${ui.year}</span><button type="button" class="prev"${atToday ? ' disabled' : ''}><svg></svg></button><button type="button" class="next"><svg></svg></button></div>`
      + `<table role="grid" aria-label="${MONTHS[ui.month - 1]} ${ui.year}"><tbody><tr>${cells}</tr></tbody></table>`
      + times
      + (wide ? '<button type="button">PT</button><button type="button">Set as TBD</button>' : '<button type="button">Pacific Time (PT)</button><button type="button">Confirm</button>');
    const q = s => box.querySelector(s);
    if (!wide) {
      q('.back').addEventListener('click', () => closeDate(false));
      [...box.querySelectorAll('button')].find(b => b.textContent === 'Confirm').addEventListener('click', () => closeDate(true));
    }
    q('.tab.start').addEventListener('click', () => { ui.tab = 'start'; drawPicker(); });
    q('.tab.end').addEventListener('click', () => {
      if (!state.date) return;
      ui.tab = 'end';
      ui.endShown = true;
      drawPicker();
    });
    q('.prev').addEventListener('click', () => { if (ui.month === 1) { ui.month = 12; ui.year--; } else ui.month--; drawPicker(); });
    q('.next').addEventListener('click', () => { if (ui.month === 12) { ui.month = 1; ui.year++; } else ui.month++; drawPicker(); });
    box.querySelectorAll('button[data-day]').forEach(b => b.addEventListener('click', () => { if (!b.disabled) pickDay(b.dataset.day); }));
    const wheel = q('.wheel');
    if (!wheel) return;
    const items = [...wheel.children];
    if (wide) {
      items.forEach((s, i) => s.addEventListener('click', () => pickTime(list[i])));
      return;
    }
    // The wheel: a row is 20px, the wheel 200px; what stops in its middle is picked.
    let top = Math.max(0, list.indexOf(ui.tab === 'start' ? state.start : state.end)) * ROW - (WHEEL / 2 - ROW / 2);
    Object.defineProperty(wheel, 'scrollTop', { configurable: true, get: () => top, set: v => { top = v; } });
    wheel.getBoundingClientRect = () => ({ top: 100, height: WHEEL, left: 0, width: 300 });
    items.forEach((s, i) => { s.getBoundingClientRect = () => ({ top: 100 + i * ROW - top, height: ROW, left: 0, width: 300 }); });
    let settle = null;
    wheel.addEventListener('scroll', () => {
      win.clearTimeout(settle);
      settle = later(20, () => {
        const i = Math.round((top + WHEEL / 2 - ROW / 2) / ROW);
        if (list[i] && picker) pickTime(list[i]);
      });
    });
  }

  // ---- place ----

  function drawPlace() {
    const b = doc.getElementById('place');
    b.innerHTML = state.place
      ? `<span>${state.place.name}</span><span>${state.place.line}</span><span>(Optional) Location · hidden before rsvp</span>`
      : '<span>Location</span><span>(Optional) Location · hidden before rsvp</span>';
  }

  function openPlace() {
    if (doc.querySelector('[role="dialog"] input[type="search"]')) return;
    // A place that's set opens on its details, where Clear empties it.
    if (state.place) {
      const dlg = el(`<div role="dialog"><button type="button" class="back"><svg></svg></button><span>Location</span><button type="button" class="clear">Clear</button><div>${state.place.name}</div><div>${state.place.line}</div><button type="button" class="save">Save</button></div>`);
      doc.body.appendChild(dlg);
      dlg.querySelector('.back').addEventListener('click', () => dlg.remove());
      dlg.querySelector('.save').addEventListener('click', () => dlg.remove());
      dlg.querySelector('.clear').addEventListener('click', () => { state.place = null; dlg.remove(); drawPlace(); });
      return;
    }
    const dlg = el('<div role="dialog"><button type="button" class="back"><svg></svg></button><span>Location</span><input type="search" placeholder="Place name, address, or link"><div class="results"></div></div>');
    doc.body.appendChild(dlg);
    dlg.querySelector('.back').addEventListener('click', () => dlg.remove());
    const input = dlg.querySelector('input');
    const typed = H.reactify(input);
    let timer = null;
    input.addEventListener('input', () => {
      win.clearTimeout(timer);
      timer = later(40, () => {
        const v = typed.value;
        const results = dlg.querySelector('.results');
        results.innerHTML = `<div class="opt" data-i="-1">Use "${v}"</div>`
          + o.suggestions.map((s, i) => `<div class="opt" data-i="${i}"><div>${s[0]}</div><div>${s[1]}</div></div>`).join('');
        results.querySelectorAll('.opt').forEach(opt => opt.addEventListener('click', () => {
          const i = Number(opt.dataset.i);
          const pick = i < 0 ? { name: v, line: '' } : { name: o.suggestions[i][0], line: o.suggestions[i][1].replace(/ \d{5}, United States$|, United States$/, '') };
          dlg.remove();
          placeDetails(pick);
        }));
      });
    });
  }

  // The second step is a new dialog; Save does nothing until it has loaded the place.
  function placeDetails(pick) {
    const dlg = el('<div role="dialog"><button type="button" class="back"><svg></svg></button><span>Location</span><div class="details">Approximate location shown before RSVP</div><input placeholder=""><input placeholder="ex: Apt 4B"><button type="button" class="save">Save</button></div>');
    dlg.querySelector('input').setAttribute('placeholder', pick.name);
    doc.body.appendChild(dlg);
    let loaded = false;
    later(60, () => { loaded = true; dlg.querySelector('.details').innerHTML = `<div>${pick.name}</div><div>${pick.line}</div>Approximate location shown before RSVP`; });
    dlg.querySelector('.back').addEventListener('click', () => { dlg.remove(); openPlace(); });
    dlg.querySelector('.save').addEventListener('click', () => {
      if (!loaded) return;
      state.place = pick;
      dlg.remove();
      drawPlace();
    });
  }

  // ---- cover image ----

  function openUpload() {
    const accept = 'image/jpeg,image/gif,image/png,image/heic,image/heif';
    const dlg = el(`<div role="dialog"><button type="button" class="close"><svg></svg></button><div>Upload</div><div>Drop it here!</div><input type="file" accept="${accept}" style="display:none"><input type="file" accept="${accept}" style="display:none"><button type="button">Upload image</button></div>`);
    doc.body.appendChild(dlg);
    dlg.querySelector('.close').addEventListener('click', () => dlg.remove());
    dlg.querySelectorAll('input[type="file"]').forEach(input => {
      H.allowFiles(input);
      input.addEventListener('change', () => {
        if (!input.files || !input.files.length) return;
        const file = input.files[0];
        input.files = [];
        later(30, () => {
          state.uploads++;
          state.cover = 'blob:https://partiful.com/' + file.name;
          doc.querySelector('[class*="EditableEventImage"] img').setAttribute('src', state.cover);
          dlg.remove();
        });
      });
    });
  }

  // ---- "We found an unsaved event!" ----

  function start() {
    if (!o.unsaved) return mount();
    const dlg = el(`<div role="dialog"><div>We found an unsaved event!</div><div>Continue editing “${o.unsaved}”?</div><button type="button">Start fresh</button><button type="button">Keep editing</button></div>`);
    doc.body.appendChild(dlg);
    const [fresh, keep] = dlg.querySelectorAll('button');
    fresh.addEventListener('click', () => { dlg.remove(); mount(); });
    keep.addEventListener('click', () => { dlg.remove(); mount(Object.assign({ title: o.unsaved }, o.saved)); });
  }

  if (o.lateMs) later(o.lateMs, start);
  else start();
  return { win, doc, state, clicks };
}

// Short waits for tests; the real ones are in partiful.js TIMING.
const FAST = { step: 5, ready: 5, open: 400, settle: 80, suggest: 400, save: 400, upload: 400 };

module.exports = { partifulPage, FAST };
