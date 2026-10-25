/* A small in-memory stand-in for the Apps Script services Code.js uses,
   so the backend can be tested on a laptop. Not a full emulator. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { googleStrip } = require('../gas-safe');

function display(v) {
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  const s = v == null ? '' : String(v);
  return s.startsWith("'") ? s.slice(1) : s;
}

class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  setValues(v) {
    if (v.length !== this.nr || v.some(row => row.length !== this.nc)) throw new Error(`setValues: ${v.length}x${v[0] && v[0].length} into ${this.nr}x${this.nc}`);
    v.forEach((row, i) => row.forEach((x, j) => this.sh.set(this.r + i, this.c + j, x)));
    return this;
  }
  getDisplayValues() {
    return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => display(this.sh.get(this.r + i, this.c + j))));
  }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, ''); return this; }
  clearDataValidations() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setNumberFormat(f) { this.sh.formats.push({ r: this.r, c: this.c, nr: this.nr, nc: this.nc, f }); return this; }
  insertCheckboxes() { return this; }
}

/* Like a new Google Sheet: 1000 rows by 26 columns. A range past the edge throws, as it does in Sheets,
   until insertRowsAfter / insertColumnsAfter make room. Inserting columns shifts the ones after it right. */
const filled = v => v !== '' && v != null;
class Sheet {
  constructor(name) { Object.assign(this, { name, cells: [], maxRows: 1000, maxCols: 26, formats: [], hidden: new Set() }); }
  set(r, c, v) { (this.cells[r - 1] = this.cells[r - 1] || [])[c - 1] = v; }
  get(r, c) { return (this.cells[r - 1] || [])[c - 1]; }
  getRange(r, c, nr = 1, nc = 1) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`bad range ${r},${c},${nr},${nc}`);
    if (r + nr - 1 > this.maxRows || c + nc - 1 > this.maxCols) throw new Error(`The coordinates of the range are outside the dimensions of the sheet (${r},${c},${nr},${nc} on ${this.maxRows}x${this.maxCols}).`);
    return new Range(this, r, c, nr, nc);
  }
  getLastRow() {
    for (let i = this.cells.length; i > 0; i--) if ((this.cells[i - 1] || []).some(filled)) return i;
    return 0;
  }
  getLastColumn() {
    let w = 0;
    this.cells.forEach(row => { for (let j = (row || []).length; j > w; j--) if (filled(row[j - 1])) { w = j; break; } });
    return w;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(after, n) { this.cells.splice(after, 0, ...Array.from({ length: n }, () => [])); this.maxRows += n; }
  insertColumnsAfter(after, n) { this.cells.forEach(row => row && row.length > after && row.splice(after, 0, ...Array(n).fill(''))); this.maxCols += n; }
  /* the number format last set on a cell */
  formatAt(r, c) { const f = this.formats.filter(x => r >= x.r && r < x.r + x.nr && c >= x.c && c < x.c + x.nc).pop(); return f ? f.f : ''; }
  setFrozenRows() {}
  hideColumns(c) { this.hidden.add(c); }
  getName() { return this.name; }
  table() { return Array.from({ length: this.getLastRow() }, (_, i) => Array.from(this.cells[i] || [], display)); }
}

/* activeUser: who is running the code. The owner when run from the script editor; '' for an anonymous web-app visitor.
   settings: rows for the Settings tab before Code.js first runs, e.g. { ORGANIZER_CODE: 'garden-test-2468' }.
   The code starts blank (nobody can sign in), so a test that signs in sets one here.
   quota: emails left today (MailApp.getRemainingDailyQuota); change it later through g.mailbox.quota.
   g.mailbox.fail(to, subject, n) can return an error message to make the nth sendEmail call throw.
   g.geo.find(address) says where an address is ({ lat, lng }), or null for one Google can't find; every address
   looked up is in g.geo.asked. g.geo.down = true makes the geocoder throw, as it does when it doesn't answer. */
function makeGas({ page, now, url = 'http://localhost:8766/', activeUser = 'owner@example.com', settings, quota = 100 } = {}) {
  const sheets = new Map([['Sheet1', new Sheet('Sheet1')]]);
  if (settings) {
    const s = new Sheet('Settings');
    [['setting', 'value', 'what it does'], ...Object.entries(settings).map(([k, v]) => [k, v, ''])].forEach((row, i) => row.forEach((v, j) => s.set(i + 1, j + 1, v)));
    sheets.set('Settings', s);
  }
  const ss = {
    getId: () => 'sheet-1',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
    getSheetByName: n => sheets.get(n) || null,
    insertSheet: n => { const s = new Sheet(n); sheets.set(n, s); return s; },
    getSheets: () => [...sheets.values()],
    deleteSheet: s => sheets.delete(s.name),
  };
  const props = {}, cache = {};
  const mail = [], calendar = [], mailbox = { quota, fail: null, calls: 0 };
  const geo = { find: () => ({ lat: 37.81, lng: -122.25 }), asked: [], down: false };
  const RealDate = Date;
  const clock = { now: now ? new RealDate(now).getTime() : null };
  class FakeDate extends RealDate {
    constructor(...a) { if (!a.length && clock.now != null) super(clock.now); else super(...a); }
    static now() { return clock.now != null ? clock.now : RealDate.now(); }
  }
  const TZ = 'America/Los_Angeles';
  const parts = d => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', weekday: 'long', }).formatToParts(d).map(p => [p.type, p.value]));
  const Utilities = {
    formatDate(d, tz, fmt) {
      const p = parts(d);
      if (fmt === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
      if (fmt === 'H') return String(Number(p.hour));
      if (fmt === 'HH:mm') return `${p.hour}:${p.minute}`;
      if (fmt === 'EEEE, MMMM d') return `${p.weekday}, ${new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'long' }).format(d)} ${Number(p.day)}`;
      if (fmt === 'MMM d') return `${new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short' }).format(d)} ${Number(p.day)}`;
      if (fmt === 'h:mm a') return `${Number(p.hour) % 12 || 12}:${p.minute} ${Number(p.hour) < 12 ? 'AM' : 'PM'}`;
      throw new Error('formatDate fmt not mocked: ' + fmt);
    },
    parseDate(s, tz, fmt) {
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/);
      if (!m) throw new Error('parseDate: ' + s);
      const want = RealDate.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
      const p = parts(new RealDate(want)), asLocal = RealDate.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute);
      return new RealDate(want + (want - asLocal));
    },
    getUuid: () => require('crypto').randomUUID(),
  };
  // values expire after their seconds (the mock clock counts), like the real CacheService
  const clockNow = () => (clock.now != null ? clock.now : RealDate.now());
  const scriptCache = {
    get: k => { const c = cache[k]; if (!c || c.until <= clockNow()) { delete cache[k]; return null; } return c.v; },
    put: (k, v, secs = 600) => { cache[k] = { v: String(v), until: clockNow() + secs * 1000 }; },
    remove: k => { delete cache[k]; },
  };
  /* Calendar: g.calendar holds the events now on each calendar ({ id, cal, title, start, end, location, description });
     createEvent adds one, its setters change it in place, and deleteEvent takes it off. getEventById finds one by id on that calendar. */
  let calSeq = 0;
  const calEvent = rec => ({
    getId: () => rec.id,
    setTime: (start, end) => { rec.start = start; rec.end = end; },
    setTitle: t => { rec.title = t; },
    setLocation: l => { rec.location = l; },
    setDescription: d => { rec.description = d; },
    deleteEvent: () => { const i = calendar.indexOf(rec); if (i >= 0) calendar.splice(i, 1); },
  });
  const calendarOf = (cal, name) => ({
    getName: () => name,
    createEvent: (title, start, end, o = {}) => { const rec = { id: `ev${++calSeq}@google.com`, cal, title, start, end, ...o }; calendar.push(rec); return calEvent(rec); },
    getEventById: id => { const rec = calendar.find(r => r.id === id && r.cal === cal); return rec ? calEvent(rec) : null; },
  });
  const logs = []; // console.log from Code.js (the Execution log in the script editor)
  const ctx = {
    console: { ...console, log: (...a) => logs.push(a.join(' ')) }, JSON, Math, Number, String, Object, Array, Set, Map, Error, RegExp, isNaN, Intl,
    Date: FakeDate,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, create: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => scriptCache },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => TZ, getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }), getActiveUser: () => ({ getEmail: () => activeUser }) },
    Utilities,
    MailApp: {
      sendEmail: (to, subject, body, opts) => {
        const why = mailbox.fail && mailbox.fail(to, subject, ++mailbox.calls);
        if (why) throw new Error(why);
        if (mailbox.quota < 1) throw new Error('Service invoked too many times for one day: email.');
        mailbox.quota--;
        mail.push({ to, subject, body, opts });
      },
      getRemainingDailyQuota: () => mailbox.quota,
    },
    CalendarApp: {
      getDefaultCalendar: () => calendarOf('default', 'Owner calendar'),
      getCalendarById: id => calendarOf(id, 'Guild calendar'),
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => url }),
      getProjectTriggers: () => [], deleteTrigger() {},
      newTrigger: fn => ({ timeBased: () => ({ everyHours: () => ({ create: () => ({ fn }) }) }) }),
    },
    HtmlService: {
      // like the real thing, strip "//" comments from inline scripts (see gas-safe.js)
      createHtmlOutputFromFile: () => ({ getContent: () => (page ? fs.readFileSync(page, 'utf8').replace(/<script>([\s\S]*?)<\/script>/g, (m, js) => '<script>' + googleStrip(js) + '</script>') : '') }),
      createHtmlOutput: content => { const o = { content, setTitle: () => o, addMetaTag: () => o }; return o; },
    },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: content => { const o = { content, setMimeType: t => { o.type = t; return o; } }; return o; } },
    Maps: { newGeocoder: () => ({ geocode: addr => {
      geo.asked.push(addr);
      if (geo.down) throw new Error('Service invoked too many times for one day: geocode.');
      const loc = geo.find(addr);
      return loc ? { status: 'OK', results: [{ geometry: { location: loc } }] } : { status: 'ZERO_RESULTS', results: [] };
    } }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dist', 'Code.js'), 'utf8'), ctx, { filename: 'Code.js' });
  return { ctx, sheets, mail, mailbox, calendar, clock, cache, logs, geo, tab: n => sheets.get(n).table() };
}

module.exports = { makeGas };
