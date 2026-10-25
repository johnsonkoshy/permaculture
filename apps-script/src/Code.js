/* EBPG Event Hub: Google Sheets + Apps Script backend.
   The Sheet is the database. Organizers can read and fix any row by hand.
   Functions ending in _ are private; the rest can be called from the page. */

/* Each tab's columns. The app finds a column by its header in row 1, not by its position, so a column
   moved or added by hand is fine. Add a new column only at the END of a list: ensure_ adds it to the Sheet. */
const TABS = {
  Events: ['id', 'label', 'title', 'date', 'start', 'end', 'place', 'address', 'host', 'co-hosts', 'description', 'bring', 'tags', 'notes', 'timeline', "data (don't edit)"],
  Bringing: ['event id', 'what', 'who', 'status', 'task id', 'last time'],
  Posts: ['event id', 'channel', 'status', 'posted by', 'text', 'edited'],
  Team: ['name', 'role', 'email or phone', 'reminders by', 'create events', 'edit events', 'post', 'assign tasks', 'manage team'],
  Volunteers: ['signed up', 'name', 'contact', 'wants to help with', 'note'],
  Activity: ['event id', 'when', 'what'],
  Gardens: ['name', 'address', 'what happens there', 'lat', 'lng'],
  Reminders: ['sent', 'key', 'to', 'subject'],
  Settings: ['setting', 'value', 'what it does'],
};
const DEFAULTS = [
  ['ORGANIZER_CODE', 'sprout-4821-bay', 'Organizers type this to sign in. Change it any time.'],
  ['TEST_MODE', 'TRUE', 'TRUE: every email goes only to the owner of this Sheet. Set FALSE to go live.'],
  ['GROUP_EMAIL', '', 'Google Group address the Post button emails, e.g. eastbaypermaculture@googlegroups.com'],
  ['CALENDAR_ID', '', "Calendar for events. Blank: the owner's main calendar."],
  ['REMINDERS', 'TRUE', 'Email people bringing things the evening before and the morning of.'],
  ['WELCOME_EMAILS', 'TRUE', 'Email new volunteers a thank-you and tell the lead organizer.'],
  ['SITE_URL', '', 'Where the Event Hub page lives, e.g. https://ebpg-event-hub.netlify.app. When set, this Google link sends people there.'],
  ['SEEDED', '', 'Set to TRUE by the app after the first sign-in fills the Sheet. Leave it.'],
];
const ROLES = { lead: 'Lead organizer', co: 'Co-organizer', vol: 'Volunteer' };
const PERM_KEYS = ['create', 'edit', 'approve', 'tasks', 'team'];

/* ---------- page ---------- */
function doGet(e) {
  ensure_();
  const ev = String((e && e.parameter && e.parameter.ev) || '').slice(0, 40);
  const site = setting_('SITE_URL');
  if (/^https:\/\/[^\s"'<>]+$/.test(site)) return moved_(site.replace(/\/$/, '') + '/' + (ev ? '?ev=' + encodeURIComponent(ev) : ''));
  const boot = { url: ScriptApp.getService().getUrl(), ev: ev };
  const page = HtmlService.createHtmlOutputFromFile('index').getContent();
  return HtmlService.createHtmlOutput('<script>' + ON_ERROR + 'window.EBPG_GAS=' + JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\//g, '\\/') + '</script>' + page)
    .setTitle('East Bay Permaculture Guild')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* Script errors show a friendly bar instead of failing silently inside Google's frame; the details go to the console.
   Same script as on_err in build.py (a test checks they match). No "//" in it: HtmlService would cut the line there.
   Browser-extension errors, cross-origin "Script error." and ResizeObserver noise are ignored. */
const ON_ERROR = "(function(){var shown=0;window.addEventListener('error',function(e){" +
  "var m=String((e&&e.message)||''),f=String((e&&e.filename)||'');" +
  "if(m==='Script error.'||/ResizeObserver loop/.test(m)||/^(chrome|moz|safari)-extension:/.test(f))return;" +
  "console.error('Event Hub error: '+m+' ('+f+' '+(e.lineno||0)+':'+(e.colno||0)+')',e.error||'');" +
  "if(shown)return;shown=1;" +
  "var d=document.createElement('div');d.id='err-bar';d.setAttribute('role','alert');" +
  "d.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:99999;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;" +
  "padding:12px max(16px,env(safe-area-inset-right,0px)) calc(12px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));" +
  "background:var(--raised,#fff);color:var(--ink,#1B2A21);border-top:3px solid var(--flag,#C24A22);box-shadow:0 -6px 20px rgba(0,0,0,.18);" +
  "font:15px/1.45 var(--body,system-ui,sans-serif)';" +
  "var t=document.createElement('span');t.style.flex='1 1 220px';" +
  "t.textContent='Something went wrong. Please refresh the page. If it keeps happening, email the Guild.';" +
  "var b=document.createElement('button');b.type='button';b.textContent='Dismiss';" +
  "b.style.cssText='border:1px solid var(--line-2,#C5CCB9);background:transparent;color:inherit;border-radius:999px;padding:7px 14px;font:inherit;font-weight:700;cursor:pointer';" +
  "b.addEventListener('click',function(){d.remove()});" +
  "d.appendChild(t);d.appendChild(b);(document.body||document.documentElement).appendChild(d)})})();";

/* The page now lives on Netlify: send visitors of the old Google link there. */
function moved_(to) {
  const js = JSON.stringify(to).replace(/</g, '\\u003c').replace(/\//g, '\\/');
  const attr = to.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return HtmlService.createHtmlOutput('<p style="font:16px/1.5 system-ui;padding:24px">The Event Hub has moved. <a target="_top" href="' + attr + '">Open it here</a>.</p>' +
    '<script>try { window.top.location.href = ' + js + '; } catch (e) {}</script>').setTitle('East Bay Permaculture Guild');
}

/* JSON API for the Netlify page: POST {"fn": "saveEvent", "args": [...]} as text/plain.
   Only these functions can be called; each one checks the organizer code itself. */
const API = { getPublic: getPublic, signIn: signIn, seed: seed, saveEvent: saveEvent, saveTeam: saveTeam, addVolunteer: addVolunteer, postTo: postTo };
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!Object.prototype.hasOwnProperty.call(API, req.fn)) throw new Error('Unknown call: ' + String(req.fn).slice(0, 40));
    out = { value: API[req.fn].apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    out = { error: String((err && err.message) || err).replace(/^Exception:\s*/, '') };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* Run once from the editor: makes the tabs and the hourly reminder trigger. */
function setup() {
  ensure_();
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'hourly') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('hourly').timeBased().everyHours(1).create();
  return 'Ready. Web app: ' + ScriptApp.getService().getUrl();
}

/* Run from the editor (not callable from the page): empties the data tabs, keeping their headers and
   the Settings, so the next organizer sign-in fills the Sheet with the starter events again. */
function resetStarterData() {
  // google.script.run can reach any public function, so refuse unless the person running it is the one it runs as (the editor)
  const me = Session.getActiveUser().getEmail();
  if (!me || me !== owner_()) throw new Error('Run resetStarterData from the script editor.');
  ensure_();
  return locked_(() => {
    ['Events', 'Bringing', 'Posts', 'Activity', 'Volunteers', 'Reminders', 'Team', 'Gardens'].forEach(name => {
      blank_(name, 2, sheet_(name).getLastRow() - 1, true); // Team has checkboxes; columns added by hand are kept
    });
    setSetting_('SEEDED', '');
    return 'Cleared. The next organizer sign-in fills the Sheet with the starter events.';
  });
}

/* ---------- calls from the page ---------- */
function getPublic() {
  ensure_();
  geocodeGardens_();
  const st = readAll_();
  return {
    events: st.events.map(r => {
      const data = Object.assign({}, r.data);
      if (data.plan) data.plan = Object.assign({}, data.plan, { notes: [], debrief: [] });
      return { data: data, cols: Object.assign({}, r.cols, { notes: '' }), tasks: [], posts: {}, log: [] };
    }),
    team: st.team.filter(t => t.role !== 'vol').map(t => ({ name: t.name, role: t.role, contact: '', via: '', perms: t.perms })),
    gardens: st.gardens,
  };
}

function signIn(code) {
  check_(code);
  const st = readAll_();
  st.empty = !on_('SEEDED') && !st.events.length;
  st.sheetUrl = book_().getUrl(); // for the Help page's "Open the Guild Sheet" link
  return st;
}

/* First organizer sign-in on an empty Sheet fills it with the starter events, once.
   After that SEEDED is TRUE, so an Events tab emptied by hand stays empty. */
function seed(code, st) {
  check_(code);
  return locked_(() => {
    if (on_('SEEDED') || rows_('Events').length) return readAll_();
    st = st || {};
    (st.events || []).forEach(saveEvent_);
    if (!readTeam_().length) writeTeam_(st.team || []);
    if (!rows_('Volunteers').length) write_('Volunteers', (st.vols || []).map(volRow_));
    if (!rows_('Gardens').length) write_('Gardens', (st.gardens || []).map(g => [g.name, g.addr, g.what, g.lat, g.lng]));
    setSetting_('SEEDED', 'TRUE');
    return readAll_();
  });
}

function saveEvent(code, ev) {
  check_(code);
  return locked_(() => { saveEvent_(ev); return true; });
}

function saveTeam(code, team) {
  check_(code);
  return locked_(() => { writeTeam_(team); return true; });
}

function addVolunteer(v) {
  const s = x => String(x == null ? '' : x).trim();
  const name = s(v && v.name).slice(0, 120), contact = s(v && v.contact).slice(0, 160);
  const help = ((v && v.help) || []).slice(0, 10).map(h => s(h).slice(0, 60)), note = s(v && v.note).slice(0, 1000);
  if (!name || !contact) throw new Error('Add your name and an email or phone.');
  const cache = CacheService.getScriptCache(), n = Number(cache.get('joins') || 0);
  if (n > 30) throw new Error('Lots of sign-ups right now. Try again in a few minutes.');
  cache.put('joins', String(n + 1), 600);
  locked_(() => append_('Volunteers', [volRow_({ date: today_(), name: name, contact: contact, help: help, note: note })]));
  if (on_('WELCOME_EMAILS')) {
    const next = upcoming_()[0];
    if (/@/.test(contact)) mail_(contact, 'Welcome to the East Bay Permaculture Guild',
      'Hi ' + name.split(' ')[0] + ',\n\nThanks for signing up to help' + (help.length ? ' with ' + help.join(', ').toLowerCase() : '') + '. An organizer will reach out soon.' +
      (next ? '\n\nOur next gathering: ' + next.title + ', ' + niceDate_(next.date) + ' at ' + niceTime_(next.start) + ', ' + next.place + '.' : '') +
      '\n\nSee you in the garden,\nThe East Bay Permaculture Guild');
    const lead = readTeam_().find(t => t.role === 'lead');
    mail_(lead && /@/.test(lead.contact) ? lead.contact : owner_(), 'New volunteer: ' + name,
      name + ' signed up.\nContact: ' + contact + '\nWants to help with: ' + (help.join(', ') || '-') + (note ? '\nNote: ' + note : '') + '\n\nThey are on the Volunteers tab of the Event Hub Sheet.');
  }
  return true;
}

/* The Post button for channels that post themselves. */
function postTo(code, eventId, channel, text) {
  check_(code);
  const ev = readEvents_().find(r => r.cols.id === eventId);
  if (!ev) throw new Error('Save the event first, then post.');
  const c = ev.cols;
  if (channel === 'ggroup') {
    const to = setting_('GROUP_EMAIL');
    if (!to && !on_('TEST_MODE')) throw new Error('Add the Google Group address on the Settings tab first.');
    const lines = String(text || '').split('\n'), first = lines[0] || '';
    const subject = /^subject:/i.test(first) ? first.replace(/^subject:\s*/i, '') : c.title + ', ' + niceDate_(c.date);
    const body = (/^subject:/i.test(first) ? lines.slice(1) : lines).join('\n').replace(/^\s+/, '');
    mail_(to || 'the Google Group', subject, body);
    return on_('TEST_MODE') ? 'Test mode: the Google Group email went to you only.' : 'Emailed the Google Group.';
  }
  if (channel === 'calendar') {
    const tz = Session.getScriptTimeZone();
    const start = Utilities.parseDate(c.date + ' ' + (c.start || '10:00'), tz, 'yyyy-MM-dd HH:mm');
    const end = Utilities.parseDate(c.date + ' ' + (c.end || c.start || '12:00'), tz, 'yyyy-MM-dd HH:mm');
    const id = setting_('CALENDAR_ID');
    const cal = (!on_('TEST_MODE') && id && CalendarApp.getCalendarById(id)) || CalendarApp.getDefaultCalendar();
    cal.createEvent(c.title, start, end, { location: [c.place, c.address].filter(String).join(', '), description: String(text || '') });
    return 'Added to ' + (cal.getName() || 'the calendar') + '.';
  }
  throw new Error('That channel is copy and paste.');
}

/* Hourly trigger: reminders the evening before (6 PM on) and the morning of (8 AM to noon). */
function hourly() {
  if (!on_('REMINDERS')) return 0;
  const tz = Session.getScriptTimeZone(), now = new Date();
  const hour = Number(Utilities.formatDate(now, tz, 'H'));
  const today = today_(), tomorrow = Utilities.formatDate(new Date(now.getTime() + 864e5), tz, 'yyyy-MM-dd');
  const team = readTeam_(), sent = new Set(rows_('Reminders').map(r => r[1]));
  const bringing = rows_('Bringing');
  let count = 0;
  readEvents_().forEach(({ cols: c }) => {
    const kind = c.date === tomorrow && hour >= 18 ? 'evening before' : c.date === today && hour >= 8 && hour < 12 ? 'morning of' : '';
    if (!kind) return;
    const when = (kind === 'morning of' ? 'today' : 'tomorrow') + ' at ' + niceTime_(c.start) + ', ' + c.place;
    const toText = [];
    bringing.filter(r => r[0] === c.id && r[2] && r[3] !== 'done' && r[3] !== 'cant').forEach(r => {
      const key = [c.id, r[4] || r[1], kind].join('|');
      if (sent.has(key)) return;
      const p = team.find(t => t.name === r[2]);
      if (p && /@/.test(p.contact)) {
        const subject = 'Reminder: ' + r[1] + ' for ' + c.title;
        mail_(p.contact, subject, 'Hi ' + p.name.split(' ')[0] + ",\n\nIt's the East Bay Permaculture Guild. You're on \"" + r[1] + '" for ' + c.title + ' ' + when + ".\n\nIf you can't make it, reply and we'll find someone. Thank you!");
        log_(key, p.contact, subject); count++;
      } else toText.push([key, r[2] + (p && p.contact ? ' (' + p.contact + ')' : '') + ': ' + r[1]]);
    });
    if (toText.length) {
      const host = team.find(t => t.name === c.host), lead = team.find(t => t.role === 'lead');
      const to = [host, lead].map(t => t && t.contact).find(x => /@/.test(x || '')) || owner_();
      const subject = 'Text these people for ' + c.title;
      mail_(to, subject, c.title + ' is ' + when + '.\nThese people have no email on the Team tab, so please text them a reminder:\n\n' + toText.map(x => '• ' + x[1]).join('\n'));
      toText.forEach(x => log_(x[0], to, subject)); count++;
    }
  });
  return count;
}

/* ---------- storage ---------- */
function book_() {
  const p = PropertiesService.getScriptProperties();
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) { if (!p.getProperty('SHEET_ID')) p.setProperty('SHEET_ID', ss.getId()); return ss; }
  const id = p.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  ss = SpreadsheetApp.create('EBPG Event Hub');
  p.setProperty('SHEET_ID', ss.getId());
  return ss;
}

function ensure_() {
  const ss = book_();
  Object.keys(TABS).forEach(name => {
    if (ss.getSheetByName(name)) { addCols_(name); return; } // an update may have added columns
    const sh = ss.insertSheet(name), head = TABS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#E8F0DF');
    sh.setFrozenRows(1);
    if (asText_(name)) sh.getRange(2, 1, sh.getMaxRows() - 1, head.length).setNumberFormat('@');
    if (name === 'Events') sh.hideColumns(head.indexOf(DATA_HEAD) + 1);
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  const settings = rows_('Settings'), have = settings.map(r => r[0]);
  const missing = DEFAULTS.filter(d => have.indexOf(d[0]) < 0);
  if (missing.length) append_('Settings', missing);
  // a Sheet filled before SEEDED existed: mark it, so it is never filled again
  const seeded = settings.find(r => r[0] === 'SEEDED');
  if (!(seeded && String(seeded[1]).trim()) && rows_('Events').length) setSetting_('SEEDED', 'TRUE');
}

/* ---------- columns by header ----------
   Row 1 holds each column's header. Reads and writes find a column by its header, matching case-insensitively
   and ignoring extra spaces, so a column moved, or one added by hand between two others, never shifts the data. */
const DATA_HEAD = "data (don't edit)"; // the Events column with the full plan as JSON
function key_(h) { return String(h == null ? '' : h).replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase(); }
function colMap_(head) {
  const at = {};
  head.forEach((h, i) => { const k = key_(h); if (k && !at[k]) at[k] = i + 1; });
  return at;
}
/* header -> 1-based column, read from row 1 */
function cols_(name) {
  const sh = sheet_(name), w = sh.getLastColumn();
  return w < 1 ? {} : colMap_(sh.getRange(1, 1, 1, w).getDisplayValues()[0]);
}
/* Team has checkboxes, so only its other tabs are kept as plain text. */
function asText_(name) { return name !== 'Team'; }
/* Add each TABS column missing from row 1 after the last used column: bold, green, plain text below.
   Columns already there are never moved, and nothing already in the Sheet is written over. Returns the header map. */
function addCols_(name, at) {
  const sh = sheet_(name);
  at = Object.assign({}, at || cols_(name));
  const missing = TABS[name].filter(h => !at[key_(h)]);
  if (!missing.length) return at;
  const from = sh.getLastColumn() + 1, last = from + missing.length - 1, max = sh.getMaxColumns();
  if (last > max) sh.insertColumnsAfter(max, last - max);
  sh.getRange(1, from, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground('#E8F0DF');
  if (asText_(name) && sh.getMaxRows() > 1) sh.getRange(2, from, sh.getMaxRows() - 1, missing.length).setNumberFormat('@');
  missing.forEach((h, i) => {
    at[key_(h)] = from + i;
    if (name === 'Events' && h === DATA_HEAD) sh.hideColumns(from + i);
  });
  return at;
}
/* TABS columns grouped into runs that sit side by side in the Sheet, so each run is one range and a column added
   by hand in between is left alone. idx: which TABS columns, by position in TABS (default: all). */
function runs_(name, idx) {
  const at = addCols_(name), out = [];
  (idx || TABS[name].map((h, i) => i)).map(i => [at[key_(TABS[name][i])], i]).sort((a, b) => a[0] - b[0]).forEach(p => {
    const run = out[out.length - 1];
    if (run && p[0] === run.col + run.idx.length) run.idx.push(p[1]);
    else out.push({ col: p[0], idx: [p[1]] });
  });
  return out;
}

function sheet_(name) { return book_().getSheetByName(name); }
/* Each row as a list in TABS order, wherever its columns are in the Sheet ('' for a column the tab doesn't have).
   keepBlank keeps row positions, so row i is Sheet row i + 2 and callers can write back to the same row. */
function rows_(name, keepBlank) {
  const sh = sheet_(name), n = sh.getLastRow();
  if (n < 2) return [];
  const v = sh.getRange(1, 1, n, sh.getLastColumn()).getDisplayValues(), at = colMap_(v[0]);
  const idx = TABS[name].map(h => (at[key_(h)] || 0) - 1);
  const out = v.slice(1).map(r => idx.map(i => i < 0 ? '' : r[i]));
  return keepBlank ? out : out.filter(r => r.some(String));
}
/* Write rows, given in TABS order, from Sheet row `at` down, each value into the column with its header.
   A row shorter than TABS leaves the columns after it alone. Adds rows to the Sheet when it runs out. Returns the runs. */
function put_(name, at, data, idx) {
  if (!data.length) return null;
  const sh = sheet_(name), w = Math.max.apply(null, data.map(r => r.length)), last = at + data.length - 1, max = sh.getMaxRows();
  if (last > max) sh.insertRowsAfter(max, last - max);
  const runs = runs_(name, idx || TABS[name].map((h, i) => i).filter(i => i < w));
  runs.forEach(run => {
    const rg = sh.getRange(at, run.col, data.length, run.idx.length);
    if (asText_(name)) rg.setNumberFormat('@');
    rg.setValues(data.map(r => run.idx.map(i => cell_(r[i]))));
  });
  return runs;
}
/* Empty the tab's own columns on `count` rows from Sheet row `from`. */
function blank_(name, from, count, validations, runs) {
  if (count < 1) return;
  const sh = sheet_(name);
  (runs || runs_(name)).forEach(run => {
    const rg = sh.getRange(from, run.col, count, run.idx.length);
    if (validations) rg.clearDataValidations();
    rg.clearContent();
  });
}
/* Replace every row: write the new table first, then clear only the old rows left below it. */
function write_(name, data) {
  const old = sheet_(name).getLastRow() - 1;
  const runs = put_(name, 2, data.map(r => TABS[name].map((h, i) => r[i]))); // every column, so the same runs clear
  blank_(name, data.length + 2, old - data.length, false, runs);
}
function append_(name, data) {
  if (data.length) put_(name, sheet_(name).getLastRow() + 1, data);
}
/* Keep everything as text, and stop a value like "=IMPORTXML(...)" running as a formula. */
function cell_(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  const s = String(v == null ? '' : v).slice(0, 45000);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function locked_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function check_(code) {
  if (String(code || '').trim() !== setting_('ORGANIZER_CODE')) throw new Error("That organizer code isn't right.");
}
function setting_(k) { const r = rows_('Settings').find(x => x[0] === k); return r ? String(r[1]).trim() : ''; }
function setSetting_(k, v) {
  const i = rows_('Settings', true).findIndex(r => r[0] === k);
  if (i >= 0) put_('Settings', i + 2, [[k, v]], [1]);
  else append_('Settings', [[k, v, '']]);
}
function on_(k) { return /^(true|yes|on|1)$/i.test(setting_(k)); }
function owner_() { return Session.getEffectiveUser().getEmail(); }
function today_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

/* In test mode every email goes to the owner, with the real recipient in the subject. */
function mail_(to, subject, body) {
  const test = on_('TEST_MODE');
  MailApp.sendEmail(test ? owner_() : to, (test ? '[TEST to ' + to + '] ' : '') + subject, body, { name: 'East Bay Permaculture Guild' });
}
function log_(key, to, subject) { append_('Reminders', [[new Date().toISOString(), key, to, subject]]); }

/* ---------- rows <-> objects ---------- */
/* Dates typed by hand: 2026-10-31, 2026/10/31, 10/31/2026, 10/31/26, 10/31 (this year), Oct 31, 2026,
   October 31 2026, Sat, Oct 31, 31 Oct 2026. Anything else comes back as typed, and isDate_ says no. */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function normDate_(s) {
  s = String(s == null ? '' : s).trim();
  const iso = (y, mo, d) => {
    y = y ? (String(y).length === 2 ? '20' + y : String(y)) : today_().slice(0, 4);
    const out = y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
    return isDate_(out) ? out : s;
  };
  const month = w => { w = w.toLowerCase(); return w.length >= 3 ? MONTHS.findIndex(x => x.indexOf(w) === 0) + 1 : 0; };
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?![\d\/-])/);
  if (m) return iso(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?$/);
  if (m) return iso(m[3], m[1], m[2]);
  m = s.match(/^(?:[a-z]+\.?,?\s+)?([a-z]+)\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?:(?:,\s*|\s+)(\d{4}))?$/i);
  if (m && month(m[1])) return iso(m[3], month(m[1]), m[2]);
  m = s.match(/^(\d{1,2})\s+([a-z]+)\.?(?:(?:,\s*|\s+)(\d{4}))?$/i);
  if (m && month(m[2])) return iso(m[3], month(m[2]), m[1]);
  return s;
}
/* a real day written as yyyy-MM-dd */
function isDate_(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === m[2] - 1 && d.getUTCDate() === +m[3];
}
/* Times typed by hand: 10:00, 9:30 AM, 2:00:00 PM, 10am, 10:30 a.m., noon, midnight. */
function normTime_(s) {
  const t = String(s == null ? '' : s).trim();
  if (/^(12(:00)?\s*)?noon$/i.test(t)) return '12:00';
  if (/^(12(:00)?\s*)?midnight$/i.test(t)) return '00:00';
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap]\.?\s?m\.?)?$/i);
  if (!m) return t;
  let h = Number(m[1]);
  const ap = (m[3] || '').toLowerCase()[0];
  if (Number(m[2] || 0) > 59 || (ap ? h < 1 || h > 12 : h > 23)) return t;
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return ('0' + h).slice(-2) + ':' + (m[2] || '00');
}
function niceDate_(d) {
  const t = Utilities.parseDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return Utilities.formatDate(t, Session.getScriptTimeZone(), 'EEEE, MMMM d');
}
function niceTime_(t) {
  const p = String(t || '').split(':').map(Number);
  if (isNaN(p[0])) return t || '';
  return (p[0] % 12 || 12) + (p[1] ? ':' + ('0' + p[1]).slice(-2) : '') + (p[0] >= 12 ? ' PM' : ' AM');
}

const EV_COLS = ['id', 'label', 'title', 'date', 'start', 'end', 'place', 'address', 'host', 'cohosts', 'about', 'bring', 'tags', 'notes', 'timeline'];
/* An event row whose date can't be read is left out, and said so in `problems` (when given) so an organizer can fix it. */
function readEvents_(problems) {
  const out = [], dataAt = TABS.Events.indexOf(DATA_HEAD);
  rows_('Events', true).forEach((r, i) => {
    const cols = {};
    EV_COLS.forEach((k, j) => { cols[k] = r[j]; });
    if (!cols.id) return;
    cols.date = normDate_(cols.date); cols.start = normTime_(cols.start); cols.end = normTime_(cols.end);
    if (!isDate_(cols.date)) {
      const typed = cols.date.length > 40 ? cols.date.slice(0, 40) + '\u2026' : cols.date;
      if (problems) problems.push({ tab: 'Events', row: i + 2, what: typed ? "date '" + typed + "' not understood" : 'date is blank' });
      return;
    }
    let data = {};
    try { data = JSON.parse(r[dataAt] || '{}'); } catch (e) { data = {}; }
    data.id = cols.id;
    out.push({ data: data, cols: cols });
  });
  return out;
}
function upcoming_() {
  const t = today_();
  return readEvents_().map(r => r.cols).filter(c => c.date >= t).sort((a, b) => a.date < b.date ? -1 : 1);
}

function saveEvent_(p) {
  const c = p.cols || {}, id = String(p.id || c.id || '').slice(0, 40);
  if (!id) throw new Error('Event has no id.');
  // a cell holds 50,000 characters; never cut the plan short, since a cut-off plan can't be read back
  const json = JSON.stringify(p.data || {});
  if (json.length > 45000) throw new Error("This event's plan is too long to save. Shorten the notes.");
  const row = [id].concat(EV_COLS.slice(1).map(k => c[k] == null ? '' : c[k]));
  row[TABS.Events.indexOf(DATA_HEAD)] = json;
  const all = rows_('Events', true), i = all.findIndex(r => r[0] === id);
  if (i >= 0) put_('Events', i + 2, [row]);
  else append_('Events', [row]);
  replaceFor_('Bringing', id, (p.tasks || []).map(t => [id, t.what, t.who || '', t.status || '', t.id || '', t.last || '']));
  replaceFor_('Posts', id, (p.posts || []).map(x => [id, x.channel, x.status, x.by || '', x.text || '', x.edited ? 'yes' : '']));
  replaceFor_('Activity', id, (p.log || []).slice(-100).map(l => [id, l[0], l[1]])); // the newest 100
}
/* Bringing, Posts and Activity: swap one event's rows, keeping every other event's. */
function replaceFor_(name, id, fresh) {
  const keep = rows_(name).filter(r => r[0] !== id);
  write_(name, keep.concat(fresh));
}

function readTeam_() {
  const yes = v => /^(true|yes|1|x)$/i.test(String(v).trim());
  return rows_('Team').map(r => {
    const role = Object.keys(ROLES).find(k => ROLES[k].toLowerCase() === String(r[1]).trim().toLowerCase() || k === String(r[1]).trim().toLowerCase()) || 'vol';
    const perms = {};
    PERM_KEYS.forEach((k, i) => { perms[k] = role === 'lead' || (role !== 'vol' && yes(r[4 + i])); });
    return { name: String(r[0]).trim(), role: role, contact: r[2], via: r[3] || (!r[2] ? '' : /@/.test(r[2]) ? 'Email' : 'Text'), perms: perms };
  }).filter(t => t.name);
}
function writeTeam_(team) {
  write_('Team', team.map(t => [t.name, ROLES[t.role] || ROLES.vol, t.contact || '', t.via || ''].concat(PERM_KEYS.map(k => !!(t.perms && t.perms[k])))));
  const n = team.length, sh = sheet_('Team');
  if (n) runs_('Team', PERM_KEYS.map((k, i) => 4 + i)).forEach(run => sh.getRange(2, run.col, n, run.idx.length).insertCheckboxes());
}
function volRow_(v) { return [v.date || today_(), v.name, v.contact, (v.help || []).join(', '), v.note || '']; }

function readAll_() {
  const byEv = (name, f) => {
    const m = {};
    rows_(name).forEach(r => { (m[r[0]] = m[r[0]] || []).push(f(r)); });
    return m;
  };
  const tasks = byEv('Bringing', r => ({ what: r[1], who: r[2], status: r[3], id: r[4], last: r[5] }));
  const posts = byEv('Posts', r => ({ channel: r[1], status: r[2], by: r[3], text: r[4], edited: !!r[5] }));
  const log = byEv('Activity', r => [r[1], r[2]]);
  const problems = []; // rows an organizer needs to fix in the Sheet
  return {
    events: readEvents_(problems).map(e => {
      const ps = {};
      (posts[e.cols.id] || []).forEach(p => { ps[p.channel] = p; });
      return { data: e.data, cols: e.cols, tasks: tasks[e.cols.id] || [], posts: ps, log: log[e.cols.id] || [] };
    }),
    team: readTeam_(),
    vols: rows_('Volunteers').map(r => ({ date: normDate_(r[0]), name: r[1], contact: r[2], help: String(r[3]).split(',').map(s => s.trim()).filter(String), note: r[4] })),
    gardens: readGardens_(),
    problems: problems,
  };
}
function readGardens_() {
  return rows_('Gardens').map(r => ({ name: r[0], addr: r[1], what: r[2], lat: Number(r[3]), lng: Number(r[4]) })).filter(g => g.name && !isNaN(g.lat) && !isNaN(g.lng) && g.lat);
}
/* Fill in lat/lng for gardens added by hand, using Google's free geocoder. */
function geocodeGardens_() {
  const all = rows_('Gardens', true);
  const todo = all.map((r, i) => [r, i]).filter(x => x[0][0] && x[0][1] && !x[0][3]);
  if (!todo.length) return;
  todo.slice(0, 5).forEach(([r, i]) => {
    try {
      const res = Maps.newGeocoder().geocode(r[1]);
      const loc = res.results && res.results[0] && res.results[0].geometry.location;
      if (loc) put_('Gardens', i + 2, [[r[0], r[1], r[2], String(loc.lat), String(loc.lng)]], [3, 4]);
    } catch (e) { /* leave it blank; the garden still shows in the list */ }
  });
}
