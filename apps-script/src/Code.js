/* EBPG Event Hub: Google Sheets + Apps Script backend.
   The Sheet is the database. Organizers can read and fix any row by hand.
   Functions ending in _ are private; the rest can be called from the page. */

/* Each tab's columns. The app finds a column by its header in row 1, not by its position, so a column
   moved or added by hand is fine. Add a new column only at the END of a list: ensure_ adds it to the Sheet. */
const TABS = {
  Events: ['id', 'label', 'title', 'date', 'start', 'end', 'place', 'address', 'host', 'co-hosts', 'description', 'bring', 'tags', 'notes', 'timeline', "data (don't edit)", 'status', 'rsvp link'],
  Bringing: ['event id', 'what', 'who', 'status', 'task id', 'last time', 'type'],
  Posts: ['event id', 'channel', 'status', 'posted by', 'text', 'edited', 'approved by', 'approved at', 'posted at', 'post url', 'calendar id', 'stale', 'original post'],
  Team: ['name', 'role', 'email or phone', 'reminders by', 'create events', 'edit events', 'post', 'assign tasks', 'manage team'],
  Volunteers: ['signed up', 'name', 'contact', 'wants to help with', 'note', 'id', 'email', 'phone', 'best way', 'free', 'heard from', 'email list', 'event'],
  Activity: ['event id', 'when', 'what'],
  Gardens: ['name', 'address', 'what happens there', 'lat', 'lng'],
  Plants: ['id', 'nickname', 'plant', 'latin name', 'where', 'planted', 'status', 'steward', 'steward contact', 'backup', 'care every (days)', 'last care', 'care notes', 'requested by', 'requested contact', 'requested at', 'token'],
  Reminders: ['sent', 'key', 'to', 'subject'],
  Channels: ['channel', 'name', 'used', 'link', 'on for new events', 'how it posts'],
  Settings: ['setting', 'value', 'what it does'],
};
/* The Channels tab's rows when it's first made. Volunteers fill in the links (the Facebook group's page, the Instagram
   account, ...) by hand; the app never writes this tab again, so hand edits stay. 'how it posts' is there to read:
   the Google Group and the Calendar post from the app, the rest are copy and paste (see AUTO). */
const CHANNEL_ROWS = [
  ['partiful', 'Partiful', 'TRUE', 'https://partiful.com/', 'TRUE', 'copy and paste'],
  ['ggroup', 'Google Group email', 'TRUE', '', 'TRUE', 'posts automatically'],
  ['calendar', 'Guild Google Calendar', 'TRUE', '', 'TRUE', 'posts automatically'],
  ['facebook', 'Facebook group', 'TRUE', '', 'TRUE', 'copy and paste'],
  ['instagram', 'Instagram', 'TRUE', '', 'TRUE', 'copy and paste'],
  ['chats', 'WhatsApp & Hylo chats', 'TRUE', '', 'TRUE', 'copy and paste'],
  ['luma', 'Luma', 'FALSE', '', 'FALSE', 'copy and paste'],
  ['meetup', 'Meetup', 'FALSE', '', 'FALSE', 'copy and paste'],
];
const DEFAULTS = [
  ['ORGANIZER_CODE', '', 'Organizers type this to sign in. At least 8 characters. Running setup fills it in when blank. Change it any time.'],
  ['TEST_MODE', 'TRUE', 'TRUE: every email goes only to the owner of this Sheet. Set FALSE to go live.'],
  ['GROUP_EMAIL', '', 'Google Group address the Post button emails, e.g. eastbaypermaculture@googlegroups.com'],
  ['CALENDAR_ID', '', "Calendar for events. Blank: the owner's main calendar."],
  ['REMINDERS', 'TRUE', 'Email people bringing things the evening before and the morning of.'],
  ['WELCOME_EMAILS', 'TRUE', 'Email new volunteers a thank-you and tell the lead organizer.'],
  ['SITE_URL', '', 'Where the Event Hub page lives, e.g. https://ebpg-event-hub.netlify.app. When set, this Google link sends people there.'],
  ['SEEDED', '', 'Set to TRUE by the app after the first sign-in fills the Sheet. Leave it.'],
  ['REPLY_TO', '', "Where replies to the hub's emails go. Blank: the lead organizer's email on the Team tab."],
  ['MAIL_RESERVE', '30', 'Welcome and new-volunteer emails wait when fewer than this many emails are left for the day, so reminders can still go out.'],
  ['SCHEDULE_TEXT', 'Garden work days at the Oakland Peace Center, plus community meetings with a potluck. Everyone is welcome, no experience needed.', 'The line on the public page about when the Guild gets together.'],
  ['WORKDAY_SCHEDULE', '4th Sundays, 10 AM', 'When garden work days usually happen, in a few words.'],
  ['LINKTREE_URL', 'https://linktr.ee/eastbaypermacultureguild', "The Guild's Linktree, linked from the public page. Starts with https://."],
  ['CONTACT_EMAIL', '', 'An email address the public page can show for questions. Blank: none is shown.'],
];
const ROLES = { lead: 'Lead organizer', co: 'Co-organizer', vol: 'Volunteer' };
const PERM_KEYS = ['create', 'edit', 'approve', 'tasks', 'team'];
/* What a saved event may hold. The page only sends these, so anything else is a hand-made request. */
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PHOTOS = ['trellis', 'moat', 'pantry', 'none'];
const TAG_KEYS = ['beginner', 'tools', 'kids', 'potluck', 'outdoor'];
const TAG_WORDS = /^[\p{L}\p{N}][\p{L}\p{N} '\u2019&.()\/+!?-]{0,29}$/u; // a tag typed by hand: plain words, 30 characters at most
const CHANNELS = ['partiful', 'luma', 'ggroup', 'calendar', 'meetup', 'facebook', 'instagram', 'chats'];
/* The channels the server posts itself, and the statuses that mean it went out ('test': in test mode, to the owner only). */
const AUTO = ['ggroup', 'calendar'];
const SENT = ['posted', 'test'];
const AUTO_NAME = { ggroup: 'the Google Group', calendar: 'the Calendar' };
const PCOL = {}; // each Posts column's place in a row from rows_('Posts'), e.g. PCOL['calendar id']
TABS.Posts.forEach((h, i) => { PCOL[h] = i; });
const MAX_LEN = { title: 200, about: 4000, bring: 500 };
/* Emails that can wait. They go out only while more than MAIL_RESERVE of the day's quota is left, so reminders still can. */
const CAN_WAIT = ['welcome', 'lead-alert', 'thanks', 'steward', 'invite'];
/* The volunteer form's choices, in the words the Volunteers tab keeps. The same lists as HELP, FREE, HEARD and the
   'Best way to reach you' buttons on the page (a test checks they match). Anything else is a hand-made request. */
const VOL_HELP = ['Meeting setup', 'Garden work days', 'Partner projects', 'Outreach & photos', 'Teaching a skill', 'Adopt a plant', 'Host a project', 'Partner organization'];
// how the welcome email says each one, in VOL_HELP order: "Thanks for signing up to help with garden work days and hosting a project."
const VOL_HELP_SAY = ['setting up for meetings', 'garden work days', 'partner projects', 'outreach and photos', 'teaching a skill', 'adopting a plant', 'hosting a project', 'partnering as an organization'];
const VOL_FREE = ['Weekend mornings', 'Weekday evenings', 'One-off projects'];
const VOL_HEARD = ['Instagram', 'Partiful', 'Google Group', 'Facebook', 'A friend', 'Walked by the garden', 'A flyer', 'Other'];
const VOL_BEST = ['Email', 'Text'];
const VOL_NAME = /^\p{L}[\p{L}\p{M} .'’-]{0,79}$/u; // letters, spaces and . ' - (80 at most), starting with a letter
const VOL_EMAIL = /^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:.]{2,}$/;
const JOIN_LIMIT = 60; // sign-ups every 10 minutes, everyone together
const VCOL = {}; // each Volunteers column's place in a row from rows_('Volunteers'), e.g. VCOL['best way']
TABS.Volunteers.forEach((h, i) => { VCOL[h] = i; });
/* Adopt a plant: a plant's status on the Plants tab. A blank one is 'needs a steward' (see plantStatus_). */
const PLANT_STATUS = ['needs a steward', 'requested', 'adopted'];
const PLCOL = {}; // each Plants column's place in a row from rows_('Plants'), e.g. PLCOL['care notes']
TABS.Plants.forEach((h, i) => { PLCOL[h] = i; });
// what savePlant may change as words, in the page's names: [column, the most it may hold, how an error names it]
const PLANT_TEXT = { plant: ['plant', 80, 'plant'], nickname: ['nickname', 40, 'nickname'], latin: ['latin name', 80, 'latin name'],
  where: ['where', 120, 'where it is'], careNotes: ['care notes', 1000, 'care notes'] };
const PLANT_ASK = ['requested by', 'requested contact', 'requested at']; // an adoption request waiting for an organizer

/* ---------- page ---------- */
function doGet(e) {
  ensure_();
  const ev = String((e && e.parameter && e.parameter.ev) || '').slice(0, 40);
  const plant = String((e && e.parameter && e.parameter.plant) || '').slice(0, 40); // a plant tag's QR code
  const site = setting_('SITE_URL');
  if (/^https:\/\/[^\s"'<>]+$/.test(site)) return moved_(site.replace(/\/$/, '') + '/' + (ev ? '?ev=' + encodeURIComponent(ev) : plant ? '?plant=' + encodeURIComponent(plant) : ''));
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
const API = { getPublic: getPublic, signIn: signIn, seed: seed, saveEvent: saveEvent, saveTeam: saveTeam, addVolunteer: addVolunteer, postTo: postTo,
  cancelEvent: cancelEvent, deleteEvent: deleteEvent, savePlant: savePlant, deletePlant: deletePlant, approveAdoption: approveAdoption, declineAdoption: declineAdoption };
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
  let out = 'Ready. Web app: ' + ScriptApp.getService().getUrl();
  // a blank code, or the one the first version shipped with (it was printed in its README), gets a new one nobody has seen
  const code = setting_('ORGANIZER_CODE');
  if (!code || code === ['sprout', '4821', 'bay'].join('-')) {
    const hex = Utilities.getUuid().replace(/[^0-9a-f]/gi, '').toLowerCase();
    const fresh = 'garden-' + hex.slice(0, 4) + '-' + hex.slice(4, 8);
    setSetting_('ORGANIZER_CODE', fresh);
    out += '\nNew organizer code: ' + fresh + ' (the ORGANIZER_CODE row on the Settings tab). Share it with the other organizers.';
  } else if (code.length < 8) {
    out += '\nThe organizer code on the Settings tab is shorter than 8 characters, so nobody can sign in. Make it longer.';
  }
  console.log(out); // the script editor shows this in the Execution log (it doesn't show return values)
  return out;
}

/* Run from the editor (not callable from the page): empties the data tabs (the plants too), keeping their headers and
   the Settings, so the next organizer sign-in fills the Sheet with the starter events again. */
function resetStarterData() {
  // google.script.run can reach any public function, so refuse unless the person running it is the one it runs as (the editor)
  const me = Session.getActiveUser().getEmail();
  if (!me || me !== owner_()) throw new Error('Run resetStarterData from the script editor.');
  ensure_();
  return writing_(() => {
    ['Events', 'Bringing', 'Posts', 'Activity', 'Volunteers', 'Reminders', 'Team', 'Gardens', 'Plants'].forEach(name => {
      blank_(name, 2, sheet_(name).getLastRow() - 1, true); // Team has checkboxes; columns added by hand are kept
    });
    setSetting_('SEEDED', '');
    usedPlantNo_(0); // the plants start again at no. 001
    return 'Cleared. The next organizer sign-in fills the Sheet with the starter events.';
  });
}

/* ---------- calls from the page ---------- */
/* The public page's data, for anyone (no organizer code). An allow-list: published events from today on, each with
   only the fields a visitor needs; the ids (only the ids) of events cancelled in the last 30 days or later, so an old
   link can say the event was cancelled; the organizers' names and roles; the gardens; and four settings. Nothing from
   the plan's notes, tasks, posts, activity or permissions. It reads only the Events, Team, Gardens and Settings tabs,
   and keeps its answer in the script cache for 5 minutes; every organizer save drops that copy (see writing_). */
const PUBLIC_KEY = 'public:v1', PUBLIC_GEN = 'public:gen', PUBLIC_MAX = 90 * 1024;
function getPublic() {
  const cache = CacheService.getScriptCache(), hit = cache.get(PUBLIC_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* worked out again below */ } }
  const gen = cache.get(PUBLIC_GEN);
  ensure_(true);
  const out = publicView_(), json = JSON.stringify(out);
  // a save that started while this was reading the Sheet changed the generation, so an older copy is never kept
  if (bytes_(json) <= PUBLIC_MAX && cache.get(PUBLIC_GEN) === gen) cache.put(PUBLIC_KEY, json, 300);
  return out;
}
function publicView_() {
  const today = today_(), set = {};
  rows_('Settings').forEach(r => { if (!Object.prototype.hasOwnProperty.call(set, r[0])) set[r[0]] = String(r[1]).trim(); });
  const when = c => c.date + ' ' + c.start, all = readEvents_();
  const since = Utilities.formatDate(new Date(Date.now() - 30 * 864e5), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return {
    events: all.filter(e => e.cols.status === 'published' && e.cols.date >= today)
      .sort((a, b) => when(a.cols) < when(b.cols) ? -1 : when(a.cols) > when(b.cols) ? 1 : 0).map(pubEvent_),
    cancelled: all.filter(e => e.cols.status === 'cancelled' && e.cols.date >= since).map(e => e.cols.id).slice(0, 100),
    team: readTeam_().filter(t => t.role !== 'vol').map(t => ({ name: t.name, role: t.role })),
    gardens: readGardens_(),
    // four settings only: the organizer code and the switches never leave the Sheet
    settings: {
      SCHEDULE_TEXT: short_(set.SCHEDULE_TEXT, 500),
      WORKDAY_SCHEDULE: short_(set.WORKDAY_SCHEDULE, 120),
      LINKTREE_URL: postUrl_(set.LINKTREE_URL),
      CONTACT_EMAIL: /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(set.CONTACT_EMAIL || '') ? short_(set.CONTACT_EMAIL, 120) : '',
    },
  };
}
/* One event as the public sees it. Hand-typed cells are checked again here: a photo the page doesn't know is 'none',
   and only https:// links get through. The host is a first name only. */
function pubEvent_(e) {
  const c = e.cols, d = e.data || {}, hm = t => /^\d{2}:\d{2}$/.test(t) ? t : '';
  const out = {
    id: c.id, label: short_(c.label, 80), title: short_(c.title, MAX_LEN.title), date: c.date, start: hm(c.start), end: hm(c.end),
    place: short_(c.place, 200), address: short_(c.address, 300), about: short_(c.about, MAX_LEN.about), bring: short_(c.bring, MAX_LEN.bring),
    tags: String(c.tags).split(',').map(t => t.trim().toLowerCase()).filter((t, i, all) => TAG_KEYS.indexOf(t) >= 0 && all.indexOf(t) === i),
    photo: PHOTOS.indexOf(d.photo) >= 0 ? d.photo : 'none',
    type: /^[a-z]{1,20}$/.test(String(d.series || '')) ? d.series : '',
    host: short_(c.host, 60).split(/\s+/)[0],
    timeline: pubTimeline_(d.plan, c.timeline),
  };
  const map = postUrl_(d.map);
  if (map) out.map = map;
  if (c.rsvp) out.rsvp = c.rsvp;
  return out;
}
/* The timeline as [time, text] rows, leaving out the ones for the leads only ('Leads set up'). It's the plan's own,
   unless the Sheet's timeline cell was changed by hand: then the cell, read the way the page reads it. */
function pubTimeline_(plan, cell) {
  const by = r => String(r[0]);
  const rows = (plan && Array.isArray(plan.timeline) ? plan.timeline : []).filter(r => Array.isArray(r) && /^\d{2}:\d{2}$/.test(String(r[0])))
    .sort((a, b) => by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : 0);
  const asText = rows.map(r => t12_(r[0]) + ' ' + r[1]).join('\n'), typed = String(cell == null ? '' : cell).trim();
  const list = typed === asText.trim() ? rows : typed.split('\n').map(line => {
    const m = line.trim().match(/^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-\u2013:]?\s+(.+)$/i), t = m && normTime_(m[1]);
    return t && /^\d{2}:\d{2}$/.test(t) ? [t, m[2], /^leads/i.test(m[2]) ? 'Leads' : ''] : null;
  }).filter(Boolean).sort((a, b) => by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : 0);
  return list.filter(r => key_(r[2]) !== 'leads').slice(0, 40).map(r => [String(r[0]), short_(r[1], 300)]);
}
/* "10:00" -> "10:00 AM", the way the page writes the timeline cell */
function t12_(t) {
  const p = String(t).split(':').map(Number);
  return (p[0] % 12 || 12) + ':' + ('0' + p[1]).slice(-2) + ' ' + (p[0] >= 12 ? 'PM' : 'AM');
}
/* the size of a string in UTF-8, as the cache counts it */
function bytes_(s) { return encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, 'x').length; }
/* The public view is about to change: forget the cached copy, and turn away one a visitor's call is putting together now. */
function dropPublic_() {
  const cache = CacheService.getScriptCache();
  cache.remove(PUBLIC_KEY);
  cache.put(PUBLIC_GEN, Utilities.getUuid(), 21600);
}
/* Organizer writes: under the lock, with the public copy dropped before and after, so a visitor's call that read
   the Sheet halfway through the write never keeps what it read. */
function writing_(fn) {
  return locked_(() => { dropPublic_(); try { return fn(); } finally { dropPublic_(); } });
}

function signIn(code) {
  check_(code);
  plantIds_(); // plants typed into the Plants tab by hand get their ids
  const st = readAll_();
  st.empty = !on_('SEEDED') && !st.events.length;
  st.sheetUrl = book_().getUrl(); // for the Help page's "Open the Guild Sheet" link
  // for the test-mode banner, and so organizers can tell whether emails really go out
  st.testMode = on_('TEST_MODE');
  st.owner = owner_();
  st.groupEmailSet = /@/.test(setting_('GROUP_EMAIL'));
  st.quota = quota_();
  return st;
}

/* First organizer sign-in on an empty Sheet fills it with the starter events, once.
   After that SEEDED is TRUE, so an Events tab emptied by hand stays empty. */
function seed(code, st) {
  check_(code);
  return writing_(() => {
    if (on_('SEEDED') || rows_('Events').length) return readAll_();
    st = st || {};
    (st.events || []).forEach(e => saveEvent_(Object.assign({}, e, { created: true }))); // new rows, so they may be added
    if (!readTeam_().length) writeTeam_(st.team || []);
    if (!rows_('Volunteers').length) write_('Volunteers', (st.vols || []).map(volRow_));
    if (!rows_('Gardens').length) write_('Gardens', (st.gardens || []).map(g => [g.name, g.addr, g.what, g.lat, g.lng]));
    try { geocodeGardens_(); } catch (e) { /* the hourly run tries again */ }
    setSetting_('SEEDED', 'TRUE');
    return readAll_();
  });
}

function saveEvent(code, ev) {
  check_(code);
  return writing_(() => { saveEvent_(ev); return true; });
}

/* Cancel event: the event is off the public page and gets no reminders, and the people already told hear about it.
   The status turns cancelled; the Calendar entry, if one was posted, is deleted (a [TEST] one from the owner's calendar);
   each other channel already posted gets a cancellation notice as a draft, for an organizer to approve and post, and
   the drafts nobody posted yet go, since there's nothing to announce. The post a notice replaces stays on record:
   Activity says who posted it, when and its link, and the notice keeps the link in 'original post', so the page can
   open the Partiful event to cancel it there. A Google Group email sent only as a test (just the Sheet owner got it)
   gets no notice, so the real Group never hears of an event it was never told about; its row goes like a draft.
   One line in Activity says who cancelled it and why.
   by: who pressed it. reason: optional, in the notices and Activity. Pressed again, it changes nothing.
   Returns { message, event }: the event as signIn reads it. */
function cancelEvent(code, id, reason, by) {
  check_(code);
  id = String(id == null ? '' : id);
  if (!ID_RE.test(id)) throw new Error('This event was removed from the Sheet.');
  reason = short_(String(reason == null ? '' : reason).replace(/\s+/g, ' '), 300);
  by = short_(by, 60);
  return writing_(() => {
    const all = rows_('Events', true), i = all.findIndex(r => r[0] === id), ST = TABS.Events.indexOf('status');
    if (i < 0 || evStatus_(all[i][ST]) === 'deleted') throw new Error('This event was removed from the Sheet.');
    const e = readEvents_().find(r => r.cols.id === id);
    if (!e) throw new Error("The Sheet can't read this event's date. Fix it on the Events tab, then cancel it.");
    const current = () => readAll_().events.find(r => r.cols.id === id);
    if (e.cols.status === 'cancelled') return { message: 'This event was already cancelled.', event: current() };
    const row = []; row[ST] = 'cancelled';
    put_('Events', i + 2, [row], [ST]);
    const postRows = rows_('Posts'), names = {}, kept = [], told = [], tested = [], record = [];
    readChannels_().forEach(c => { names[c.id] = c.name; });
    let cal = '';
    postRows.filter(r => r[0] === id).forEach(r => {
      const ch = r[1], status = String(r[PCOL.status] || ''), name = names[ch] || ch;
      if (SENT.indexOf(status) < 0) return; // a draft nobody posted: nothing to take back
      if (ch === 'calendar') {
        // the entry comes off the calendar it went on; the row stays as the record that it was posted
        const out = r.slice(), test = status === 'test';
        let gone = true;
        try { const ce = calEvent_(calendar_(test), r[PCOL['calendar id']]); if (ce) ce.deleteEvent(); } catch (er) { gone = false; }
        out[PCOL.stale] = gone ? '' : 'yes'; // yes: it's still there, and the page says to delete it by hand
        if (gone) out[PCOL['calendar id']] = '';
        cal = gone ? (test ? "Took the [TEST] entry off the Sheet owner's calendar" : 'Took it off the Calendar') : "Couldn't take it off the Calendar. Delete it there by hand.";
        kept.push(out);
        return;
      }
      if (status === 'test') { tested.push(name); return; } // only the Sheet owner got it: nobody to tell
      record.push(postedLine_(name, r));
      // the notice is marked edited, so nothing in the page writes the announcement back over it
      const out = TABS.Posts.map(() => '');
      out[0] = id; out[1] = ch; out[PCOL.status] = 'review'; out[PCOL.text] = cancelText_(ch, e.cols, reason); out[PCOL.edited] = 'yes';
      out[PCOL['original post']] = postUrl_(r[PCOL['post url']]) || postUrl_(r[PCOL['original post']]);
      kept.push(out);
      told.push(name);
    });
    replaceFor_('Posts', id, kept, postRows);
    const lines = [(by || 'An organizer') + ' cancelled the event' + (reason ? ': ' + reason : '')];
    if (cal) lines.push(cal);
    const untold = tested.length ? tested.join(' and ') + ' went only to the Sheet owner as a test, so ' + (tested.length === 1 ? 'it needs' : 'they need') + ' no notice' : '';
    if (untold) lines.push(untold);
    lines.push.apply(lines, record);
    if (told.length) lines.push('Drafted a cancellation notice for ' + told.join(', '));
    append_('Activity', lines.map(l => [id, stamp_(), l]));
    const message = "Cancelled. It's off the public site" + (cal && !/^Couldn't/.test(cal) ? ' and the calendar' : '') + '.' +
      (told.length ? ' ' + (told.length === 1 ? 'A cancellation notice is' : told.length + ' cancellation notices are') + ' waiting for review in Outreach.' : '') +
      (untold ? ' The ' + untold + '.' : '') +
      (/^Couldn't/.test(cal) ? ' ' + cal : '');
    return { message: message, event: current() };
  });
}
/* The record of a post a cancellation notice replaces, for Activity: "Partiful was posted by Phil on Oct 20: <link>". */
function postedLine_(name, r) {
  const by = short_(r[PCOL['posted by']], 60), at = new Date(String(r[PCOL['posted at']] || '')), url = postUrl_(r[PCOL['post url']]);
  const when = isNaN(at.getTime()) ? '' : ' on ' + Utilities.formatDate(at, Session.getScriptTimeZone(), 'MMM d');
  return name + ' was posted' + (by ? ' by ' + by : '') + when + (url ? ': ' + url : '');
}
/* A cancellation notice: "Cancelled: <title> on <date>. <reason>", and for the Google Group with a subject line.
   The page has the same words in cancelText, for when it runs without the Sheet. */
function cancelText_(ch, c, reason) {
  const why = reason ? ' ' + reason + (/[.!?]$/.test(reason) ? '' : '.') : '';
  const line = 'Cancelled: ' + c.title + ' on ' + niceDate_(c.date) + '.' + why + ' Sorry for the change. We hope to see you at the next one.';
  return ch === 'ggroup' ? 'Subject: Cancelled: ' + c.title + ' on ' + niceDate_(c.date) + '\n\nHi all,\n\n' + line + '\n\nThe East Bay Permaculture Guild' : line;
}

/* Delete draft: for an event made by mistake. Only a draft that was never published and has nothing posted can go; any
   other event is cancelled instead, so its link can say so. The Events row stays as a tombstone (status deleted, which
   every read skips and no save can bring back); its Bringing, Posts and Activity rows go. An id the Sheet doesn't have
   (never saved, or deleted already) is fine: there's nothing to delete. Returns true. */
function deleteEvent(code, id) {
  check_(code);
  id = String(id == null ? '' : id);
  if (!ID_RE.test(id)) return true;
  return writing_(() => {
    const all = rows_('Events', true), i = all.findIndex(r => r[0] === id), ST = TABS.Events.indexOf('status');
    if (i < 0) return true;
    const status = evStatus_(all[i][ST]);
    if (status === 'deleted') return true;
    let data = {};
    try { data = JSON.parse(all[i][TABS.Events.indexOf(DATA_HEAD)] || '{}') || {}; } catch (e) { data = {}; }
    const published = status === 'published' || data.wasPublished === true ||
      rows_('Activity').some(r => r[0] === id && /\bpublished the event\b/.test(r[2]));
    if (status !== 'draft' || published) throw new Error("This event has been on the public site, so it can't be deleted. Cancel it instead.");
    if (rows_('Posts').some(r => r[0] === id && SENT.indexOf(r[PCOL.status]) >= 0)) throw new Error('Something about this event was already posted, so it can\'t be deleted. Cancel it instead.');
    const row = []; row[ST] = 'deleted';
    put_('Events', i + 2, [row], [ST]);
    ['Bringing', 'Posts', 'Activity'].forEach(name => replaceFor_(name, id, []));
    return true;
  });
}

function saveTeam(code, team) {
  check_(code);
  return writing_(() => { writeTeam_(team); return true; });
}

/* ---------- Adopt a plant ----------
   The Plants tab lists the plants the Guild would like a neighbor to look after: what it is, where it grows, how often
   it needs care, and who looks after it (the steward, and a backup). Organizers add plants on the Plants page or type
   them into the tab; a row typed in by hand gets its id (the next number: 001, 002, ...) and its token on the next load.
   The token is the plant's own secret for links in the steward's emails, so it never goes to the page.
   Each change below runs under the lock, after checking the organizer code, and answers with every plant as signIn
   reads them, so the page shows what the Sheet now has. */

/* Add a plant (no id) or change one (its id). p holds only what changes, in the page's names: plant, nickname, latin,
   where, planted and lastCare (yyyy-mm-dd, or blank), careEvery (1 to 60 days, or blank), careNotes, steward and
   backup (someone on the Team or Volunteers tab, or blank; stewardVol and backupVol are their Volunteers id when the
   page knows it), and status. The status follows the steward: adopted with one, requested while someone's request
   waits, needs a steward otherwise; one sent from the page is only checked. The steward contact is copied from their
   Team or Volunteers row. A name already in the row stays allowed (typed by hand for someone on neither tab), with the
   contact typed beside it. While a request waits, nobody else can be made the steward: approve or decline it first.
   A new plant needs plant. cid: the page's own id for an Add, so an Add sent again (after no answer) changes the plant
   it added instead of adding a second one. Returns { plant, plants }. */
function savePlant(code, p) {
  check_(code);
  p = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  const s = x => String(x == null ? '' : x).trim(), has = k => Object.prototype.hasOwnProperty.call(p, k), C = PLCOL;
  let id = s(p.id);
  if (id && !ID_RE.test(id)) throw new Error('This plant was removed from the Sheet.');
  const set = {}; // column -> its new value
  Object.keys(PLANT_TEXT).forEach(k => {
    if (!has(k)) return;
    const [col, most, what] = PLANT_TEXT[k];
    const v = k === 'careNotes' ? String(p[k] == null ? '' : p[k]).replace(/\r\n?/g, '\n').trim() : s(p[k]).replace(/\s+/g, ' ');
    if (v.length > most) throw new Error('Please keep the ' + what + ' to ' + most + ' characters or fewer.');
    set[col] = v;
  });
  if ((!id || has('plant')) && !set.plant) throw new Error('Add what kind of plant it is.');
  [['planted', 'planted', 'The planted date'], ['lastCare', 'last care', 'The last cared for date']].forEach(([k, col, what]) => {
    if (!has(k)) return;
    const v = s(p[k]);
    if (v && !isDate_(v)) throw new Error(what + " doesn't look right. Pick a day, or leave it blank.");
    set[col] = v;
  });
  if (has('careEvery')) {
    const v = s(p.careEvery);
    if (v && !(/^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 60)) throw new Error('Care every can be 1 to 60 days.');
    set['care every (days)'] = v ? String(Number(v)) : '';
  }
  if (has('status') && s(p.status) && PLANT_STATUS.indexOf(key_(p.status)) < 0) throw new Error("That status isn't one the Plants tab uses.");
  const cid = /^[A-Za-z0-9-]{8,64}$/.test(s(p.cid)) ? s(p.cid) : '';
  return writing_(() => {
    plantsTab_();
    const cache = CacheService.getScriptCache();
    if (!id && cid) id = cache.get('plant-cid:' + cid) || ''; // this Add got through before: change the plant it added
    const all = rows_('Plants', true), i = id ? all.findIndex(r => s(r[C.id]) === id) : -1;
    if (id && i < 0) throw new Error('This plant was removed from the Sheet.');
    const row = i >= 0 ? all[i].slice() : TABS.Plants.map(() => '');
    const asked = s(row[C['requested by']]), waiting = !!asked && plantStatus_(row[C.status], row[C.steward]) === 'requested';
    if (has('steward') && s(p.steward) && waiting) throw new Error(asked + ' asked to adopt this plant. Approve or decline that first.');
    const person = (k, nameCol, contactCol) => {
      if (!has(k)) return;
      const name = s(p[k]).replace(/\s+/g, ' '), was = s(row[nameCol]), same = !!name && key_(name) === key_(was);
      if (!name) { row[nameCol] = ''; if (contactCol >= 0) row[contactCol] = ''; return; }
      const who = plantPerson_(name, s(p[k + 'Vol']));
      if (!who && !same) throw new Error(short_(name, 60) + " isn't on the Team or Volunteers tab. Pick someone from the list.");
      row[nameCol] = who ? who.name : was;
      if (contactCol >= 0) row[contactCol] = (who && who.contact) || (same ? s(row[contactCol]) : '');
    };
    person('steward', C.steward, C['steward contact']);
    person('backup', C.backup, -1);
    Object.keys(set).forEach(col => { row[C[col]] = set[col]; });
    if (i < 0 || has('steward') || has('status')) row[C.status] = s(row[C.steward]) ? 'adopted' : waiting ? 'requested' : 'needs a steward';
    if (!s(row[C.token])) row[C.token] = newToken_();
    if (i >= 0) put_('Plants', i + 2, [row]);
    else {
      const n = nextPlantNo_(all);
      id = row[C.id] = plantNo_(n);
      append_('Plants', [row]);
      usedPlantNo_(n);
      if (cid) cache.put('plant-cid:' + cid, id, 600);
    }
    const plants = readPlants_();
    return { plant: plants.find(x => x.id === id) || null, plants: plants };
  });
}
/* Take a plant off the list: its row goes from the Plants tab, with anything typed beside it. An id the tab doesn't
   have (never saved, or taken off already) is fine. Returns { plants }. */
function deletePlant(code, id) {
  check_(code);
  id = String(id == null ? '' : id).trim();
  return writing_(() => {
    if (!plantsTab_()) return { plants: [] };
    const i = ID_RE.test(id) ? rows_('Plants', true).findIndex(r => String(r[PLCOL.id]).trim() === id) : -1;
    if (i >= 0) {
      try { sheet_('Plants').deleteRow(i + 2); } catch (e) { blank_('Plants', i + 2, 1); } // a tab with no other row to keep: empty it instead
    }
    return { plants: readPlants_() };
  });
}
/* Yes to an adoption request: the person who asked becomes the steward (their name and contact move into the steward
   columns), the plant is adopted, and the request columns are emptied. Returns { message, plants }. */
function approveAdoption(code, id) {
  check_(code);
  return writing_(() => {
    const at = plantAt_(id), row = at.row, C = PLCOL, s = x => String(x == null ? '' : x).trim(), who = s(row[C['requested by']]);
    if (!who || plantStatus_(row[C.status], row[C.steward]) !== 'requested') throw new Error(noRequest_(row));
    row[C.steward] = who; row[C['steward contact']] = s(row[C['requested contact']]); row[C.status] = 'adopted';
    PLANT_ASK.forEach(h => { row[C[h]] = ''; });
    put_('Plants', at.i + 2, [row]);
    return { message: who.split(' ')[0] + ' is looking after ' + (s(row[C.nickname]) || s(row[C.plant])) + ' now.', plants: readPlants_() };
  });
}
/* No to an adoption request: the request columns are emptied and the plant needs a steward again. Returns { message, plants }. */
function declineAdoption(code, id) {
  check_(code);
  return writing_(() => {
    const at = plantAt_(id), row = at.row, C = PLCOL, s = x => String(x == null ? '' : x).trim();
    if (!s(row[C['requested by']]) || plantStatus_(row[C.status], row[C.steward]) !== 'requested') throw new Error(noRequest_(row));
    PLANT_ASK.forEach(h => { row[C[h]] = ''; });
    row[C.status] = s(row[C.steward]) ? 'adopted' : 'needs a steward';
    put_('Plants', at.i + 2, [row]);
    return { message: (s(row[C.nickname]) || s(row[C.plant])) + ' needs a steward again.', plants: readPlants_() };
  });
}
/* the Plants row with this id, and its place: i is Sheet row i + 2 */
function plantAt_(id) {
  id = String(id == null ? '' : id).trim();
  const all = ID_RE.test(id) && plantsTab_() ? rows_('Plants', true) : [], i = all.findIndex(r => String(r[PLCOL.id]).trim() === id);
  if (i < 0) throw new Error('This plant was removed from the Sheet.');
  return { i: i, row: all[i].slice() };
}
// approve or decline pressed again, or from a page that missed what another organizer did
function noRequest_(row) {
  const st = String(row[PLCOL.steward] || '').trim();
  return st ? st + ' is looking after this plant already.' : 'Nobody is waiting to adopt this plant now.';
}
/* Someone picked as a steward or backup: on the Team tab, or signed up on the Volunteers tab (vol: their Volunteers id,
   which picks the right row when two sign-ups share a name; without it, the newest sign-up with that name). Returns
   their name as that tab has it and how to reach them, an email first (the steward emails need one), or null for
   someone on neither tab. Picked as a volunteer, their sign-up's email or phone comes first; as a team member, the
   Team tab's. */
function plantPerson_(name, vol) {
  const k = key_(name), s = x => String(x == null ? '' : x).trim();
  if (!k) return null;
  const vols = rows_('Volunteers').filter(r => key_(r[VCOL.name]) === k);
  const v = (vol && vols.find(r => s(r[VCOL.id]) === vol)) || vols[vols.length - 1];
  const t = readTeam_().find(x => key_(x.name) === k);
  if (!t && !v) return null;
  const c = v ? volContact_(v) : { email: '', phone: '' }, theirs = c.email || c.phone, team = s(t && t.contact);
  return { name: t ? t.name : s(v[VCOL.name]), contact: (vol && v ? theirs || team : team || theirs) };
}
/* A plant's status as the app reads it: one of PLANT_STATUS, whatever the case or spacing. A blank cell, or a word the
   app doesn't know, is 'needs a steward', or 'adopted' when the row names a steward. */
function plantStatus_(v, steward) {
  const k = key_(v);
  if (PLANT_STATUS.indexOf(k) >= 0) return k;
  return String(steward == null ? '' : steward).trim() ? 'adopted' : 'needs a steward';
}
/* The Plants tab, made now if this Sheet is from before it. Says whether it's there. */
function plantsTab_() {
  if (!sheet_('Plants')) { try { ensure_(); } catch (e) { /* made at the same moment by another call */ } }
  return !!sheet_('Plants');
}
/* The Plants tab as the organizers' page uses it, in the Sheet's order, without the tokens. Dates typed by hand are read
   like the Events tab's. A row with no id yet waits for backfillPlants_; one whose id can't be used, or repeats an
   earlier row's, is listed in problems (when given), so an organizer can fix it. */
function readPlants_(problems) {
  if (!plantsTab_()) return [];
  const C = PLCOL, s = x => String(x == null ? '' : x).trim(), seen = {}, out = [];
  rows_('Plants', true).forEach((r, i) => {
    const id = s(r[C.id]);
    if (!id || !r.some(String)) return;
    const say = what => { if (problems) problems.push({ tab: 'Plants', row: i + 2, what: what }); };
    if (!ID_RE.test(id)) return say('the id can only use letters, numbers, - and _ (40 at most)');
    if (seen[id]) return say("the id '" + id.slice(0, 40) + "' is on row " + seen[id] + ' too');
    seen[id] = i + 2;
    const every = s(r[C['care every (days)']]).match(/^(\d{1,3})\b/);
    out.push({
      id: id, nickname: s(r[C.nickname]), plant: s(r[C.plant]), latin: s(r[C['latin name']]), where: s(r[C.where]),
      planted: normDate_(r[C.planted]), status: plantStatus_(r[C.status], r[C.steward]),
      steward: s(r[C.steward]), stewardContact: s(r[C['steward contact']]), backup: s(r[C.backup]),
      careEvery: every ? Number(every[1]) : null, lastCare: normDate_(r[C['last care']]), careNotes: s(r[C['care notes']]),
      requestedBy: s(r[C['requested by']]), requestedContact: s(r[C['requested contact']]), requestedAt: s(r[C['requested at']]),
    });
  });
  return out;
}
const plantNeeds_ = r => r.some(String) && (!String(r[PLCOL.id]).trim() || !String(r[PLCOL.token]).trim());
const newToken_ = () => Utilities.getUuid().replace(/-/g, '');
/* The next plant number: after every numbered id in these rows, and after every number given before (kept in the
   script's properties as PLANT_NO), so a plant taken off the list never passes its number on: a printed tag's QR code
   keeps meaning its own plant. usedPlantNo_ notes one as given. plantNo_ writes it with three digits (7: '007'). */
function nextPlantNo_(all) {
  const kept = Number(PropertiesService.getScriptProperties().getProperty('PLANT_NO')) || 0;
  return all.reduce((m, r) => { const id = String(r[PLCOL.id]).trim(); return /^\d{1,6}$/.test(id) ? Math.max(m, Number(id)) : m; }, kept) + 1;
}
function usedPlantNo_(n) { PropertiesService.getScriptProperties().setProperty('PLANT_NO', String(n)); }
function plantNo_(n) { return n < 1000 ? ('00' + n).slice(-3) : String(n); }
/* Plants typed into the tab by hand get an id and a token, in one write. all: rows_('Plants', true), if just read.
   Says whether anything was written. */
function backfillPlants_(all) {
  all = all || rows_('Plants', true);
  if (!all.some(plantNeeds_)) return false;
  const C = PLCOL;
  const first = nextPlantNo_(all);
  let next = first;
  put_('Plants', 2, all.map(r => {
    const out = [], live = r.some(String);
    out[C.id] = String(r[C.id]).trim() || (live ? plantNo_(next++) : '');
    out[C.token] = String(r[C.token]).trim() || (live ? newToken_() : '');
    return out;
  }), [C.id, C.token]);
  if (next > first) usedPlantNo_(next - 1);
  return true;
}
/* signIn: the hand-typed rows get their ids under the lock, and only when one needs them (signIn runs every 2 minutes). */
function plantIds_() {
  if (!plantsTab_() || !rows_('Plants', true).some(plantNeeds_)) return;
  writing_(() => backfillPlants_());
}

/* The volunteer form, for anyone (no organizer code). v: { name, email, phone, best, help, free, heard, note, list,
   event, id, elapsed, website }. help, free and heard are the words on the form's choices; id is the page's own id for
   this sign-up, sent again when the visitor presses Try again; elapsed is how long the form was open, in ms, measured on
   the visitor's device with a clock that never goes back (so a clock that's off doesn't matter); website is a box only
   bots can see.
   A bot (the hidden box filled in, or the form sent within 3 seconds of opening) and a second send of the same id
   within 10 minutes are told all went well and change nothing.
   The same person is the same email or phone with the same first name. Someone already on the Volunteers tab gets
   their row updated, not a second row, and no second welcome email; within the hour of their last sign-up their
   answers are still kept, with no email at all. Someone else who shares an email or phone (a household, a group's
   info@ address) gets a row of their own, and no welcome when that email is on the tab already, so a stranger's
   inbox can't be flooded. Returns true. */
function addVolunteer(v) {
  v = v && typeof v === 'object' ? v : {};
  const s = x => String(x == null ? '' : x).trim();
  if (s(v.website)) return true;
  const took = Number(v.elapsed);
  if (s(v.elapsed) !== '' && !isNaN(took) && took >= 0 && took < 3000) return true; // below 0: the visitor's clock went back
  const name = s(v.name).replace(/\s+/g, ' ');
  if (!name) throw new Error('Add your name so we know who to welcome.');
  if (!VOL_NAME.test(name)) throw new Error("Please write your name with letters, spaces and . ' - only (80 characters at most).");
  let email = s(v.email), phone = s(v.phone);
  const one = s(v.contact); // a page from before the separate email and phone boxes sends one 'contact'
  if (!email && !phone && one) { if (/@/.test(one)) email = one; else phone = one; }
  if (!email && !phone) throw new Error('Add an email or phone number so an organizer can reach you.');
  if (email && (email.length > 120 || !VOL_EMAIL.test(email))) throw new Error("That email address doesn't look right. Please check it.");
  const digits = phone.replace(/\D/g, '');
  if (phone && (phone.length > 30 || !/^[0-9+().\s-]+$/.test(phone) || digits.length < 7 || digits.length > 15)) throw new Error('Please check your phone number. It needs at least 7 digits.');
  const pick = (list, vals) => {
    const out = [];
    (Array.isArray(vals) ? vals.slice(0, 20) : s(vals) ? [vals] : []).forEach(x => {
      const hit = list.find(l => key_(l) === key_(x));
      if (!hit) throw new Error("One of your choices isn't on the form anymore. Please refresh the page and try again.");
      if (out.indexOf(hit) < 0) out.push(hit);
    });
    return out;
  };
  const help = pick(VOL_HELP, v.help), free = pick(VOL_FREE, v.free), heard = pick(VOL_HEARD, v.heard)[0] || '';
  let best = pick(VOL_BEST, v.best)[0] || (email ? 'Email' : 'Text');
  if (best === 'Email' && !email) best = 'Text';
  if (best === 'Text' && !phone) best = 'Email';
  const note = s(v.note);
  if (note.length > 1000) throw new Error('Your note is a little long. Please keep it under 1,000 characters.');
  const list = email && (v.list === true || /^(true|yes|on|1)$/i.test(s(v.list))) ? 'yes' : '';
  const evId = ID_RE.test(s(v.event)) ? s(v.event) : '';
  const cid = /^[A-Za-z0-9-]{8,64}$/.test(s(v.id)) ? s(v.id) : '';

  const cache = CacheService.getScriptCache(), today = today_();
  const mail = email.toLowerCase(), tel = phoneKey_(phone), who = firstName_(name);
  // the same person: this email or phone with this first name, so two people on one household email stay two people
  const cool = [mail && 'join-e:' + mail + '|' + who, tel && 'join-p:' + tel + '|' + who].filter(Boolean);
  const bucket = 'joins:' + Math.floor(Date.now() / 6e5);
  const done = locked_(() => {
    if (cid && cache.get('join-id:' + cid)) return null; // Try again, after a send the Sheet did get
    const n = Number(cache.get(bucket) || 0);
    if (n >= JOIN_LIMIT) throw new Error('Lots of sign-ups right now. Please try again in a few minutes.');
    const quiet = cool.some(k => cache.get(k)); // they signed up within the hour: their answers are kept, with no email
    const all = rows_('Volunteers', true), C = VCOL;
    const byMail = r => !!mail && volContact_(r).email.toLowerCase() === mail, byTel = r => !!tel && phoneKey_(volContact_(r).phone) === tel;
    const theirs = r => r.some(String) && (byMail(r) || byTel(r)) && firstName_(r[C.name]) === who;
    let i = all.findIndex(theirs), r = null, line = '';
    if (i >= 0) {
      // already on the list: their row, with the new choices added and a line in the note. The name stays as it is.
      const was = volContact_(all[i]), also = [];
      r = all[i].slice();
      if (email && was.email && was.email.toLowerCase() !== mail) also.push('email ' + email);
      if (phone && was.phone && phoneKey_(was.phone) !== tel) also.push('phone ' + phone);
      line = 'Signed up again ' + today + (key_(r[C.name]) !== key_(name) ? ' as ' + name : '') + (also.length ? ' with ' + also.join(' and ') : '') + (note ? ': ' + note : '');
      if (String(r[C.note] || '').length + line.length > 45000) i = -1; // a cell holds 50,000 characters: a new row for them
    }
    // others with this email or phone (a household, a group's address): the lead hears who, and a welcome only to a new email
    const others = test => all.filter(x => x.some(String) && test(x) && firstName_(x[C.name]) !== who).map(x => s(x[C.name])).filter((x, j, a) => x && a.indexOf(x) === j);
    const shared = i >= 0 ? { mail: [], tel: [] } : { mail: others(byMail), tel: others(byTel) };
    const known = all.some(x => x.some(String) && byMail(x));
    let id;
    if (i >= 0) {
      const merge = (cell, add) => { const had = String(cell || '').split(',').map(x => x.trim()).filter(String); add.forEach(x => { if (had.indexOf(x) < 0) had.push(x); }); return had.join(', '); };
      const was = volContact_(r), said = String(r[C.note] || '').split('\n');
      r[C['wants to help with']] = merge(r[C['wants to help with']], help);
      r[C.free] = merge(r[C.free], free);
      if (said[said.length - 1] !== line) r[C.note] = (r[C.note] ? r[C.note] + '\n' : '') + line; // the same answers twice: one line
      r[C.email] = was.email || email; r[C.phone] = was.phone || phone;
      if (!String(r[C.contact]).trim()) r[C.contact] = r[C.email] || r[C.phone];
      r[C['best way']] = best;
      if (heard && !r[C['heard from']]) r[C['heard from']] = heard;
      if (list) r[C['email list']] = 'yes';
      if (evId) r[C.event] = evId;
      id = r[C.id] = r[C.id] || newVolId_();
      put_('Volunteers', i + 2, [r], ['contact', 'wants to help with', 'note', 'id', 'email', 'phone', 'best way', 'free', 'heard from', 'email list', 'event'].map(h => C[h]));
      all[i] = r;
    } else {
      id = newVolId_();
      append_('Volunteers', [volRow_({ date: today, name: name, email: email, phone: phone, help: help, note: note, id: id, best: best, free: free, heard: heard, list: list, event: evId })]);
    }
    backfillVolIds_(all); // rows from before the id column, or typed in by hand
    cache.put(bucket, String(n + 1), 600);
    if (cid) cache.put('join-id:' + cid, id, 600);
    cool.forEach(k => cache.put(k, id, 3600));
    return { again: i >= 0, quiet: quiet, known: known, shared: shared };
  });
  if (!done || done.quiet || !on_('WELCOME_EMAILS')) return true;
  // the sign-up is saved already, so an email that fails is noted on the Reminders tab instead of failing the sign-up
  const tryMail = (to, subject, body, kind) => { try { mail_(to, subject, body, kind); } catch (e) { log_(kind, to, 'failed: ' + msg_(e)); } };
  const ups = upcoming_(), coming = evId ? ups.find(e => e.id === evId) : null, next = coming || ups[0]; // published events only
  const when = e => e.title + ', ' + niceDate_(e.date) + (/^\d{2}:\d{2}$/.test(e.start) ? ' at ' + niceTime_(e.start) : '') + (e.place ? ', ' + e.place : '');
  const and = l => l.length > 1 ? l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1] : l.join('');
  if (email && !done.again && !done.known) {
    // the greeting is the first name only when it's plain letters: a name can't carry a link or a message to a stranger
    const first = name.split(' ')[0], hi = /^[\p{L}\p{M}-]{1,30}$/u.test(first) ? first : 'there';
    const link = next ? eventLink_(next.id) : '', says = help.map(h => VOL_HELP_SAY[VOL_HELP.indexOf(h)] || h.toLowerCase());
    tryMail(email, 'Welcome to the East Bay Permaculture Guild',
      'Hi ' + hi + ',\n\nThanks for signing up to help' + (says.length ? ' with ' + and(says) : '') + '. An organizer will reach out soon.' +
      (next ? '\n\n' + (coming ? 'See you at ' : 'Our next gathering: ') + when(next) + '.' + (link ? '\nDetails and directions: ' + link : '') : '') +
      '\n\nSee you in the garden,\nThe East Bay Permaculture Guild\n\nJust reply to this email if you have questions.', 'welcome');
  }
  const lines = [
    name + (done.again ? ' signed up again. Their row on the Volunteers tab now has these choices too.' : ' signed up to volunteer.'),
    email && 'Email: ' + email, phone && 'Phone: ' + phone, 'Best way to reach them: ' + (best === 'Text' ? 'a text' : 'email'),
    'Wants to help with: ' + (help.join(', ') || '-'), free.length && 'Usually free: ' + free.join(', '), heard && 'Heard about us from: ' + heard,
    list && 'Guild email list: yes, please add them', coming && 'Coming to: ' + when(coming), note && 'Note: ' + note,
    done.shared.mail.length && 'Shares this email with ' + and(done.shared.mail) + '. They have a row of their own, and no second welcome went to that address.',
    done.shared.tel.length && 'Shares this phone with ' + and(done.shared.tel) + '. They have a row of their own.',
  ].filter(Boolean);
  tryMail(leadEmail_() || owner_(), (done.again ? 'Volunteer signed up again: ' : 'New volunteer: ') + name,
    lines.join('\n') + '\n\nThey are on the Volunteers tab of the Event Hub Sheet.', 'lead-alert');
  return true;
}
/* a name's first word, as the Sheet compares names: 'Maya O' and 'maya ortiz' are both 'maya' */
function firstName_(n) { return key_(n).split(' ')[0]; }
/* digits only, without a leading US 1, so (510) 555-0101 and +1 510 555 0101 are the same phone; '' when too short */
function phoneKey_(p) {
  const d = String(p == null ? '' : p).replace(/\D/g, '');
  return d.length < 7 ? '' : d.length === 11 && d[0] === '1' ? d.slice(1) : d;
}
/* A Volunteers row's email and phone. Rows from before those columns have only 'contact': an email or a phone. */
function volContact_(r) {
  const c = String(r[VCOL.contact] || '').trim(), at = /@/.test(c);
  return { email: String(r[VCOL.email] || '').trim() || (at ? c : ''), phone: String(r[VCOL.phone] || '').trim() || (at ? '' : c) };
}
function newVolId_() { return Utilities.getUuid().slice(0, 8); }
/* An event's public page: on SITE_URL when it's set, else this web app (doGet sends ?ev= on to SITE_URL too). */
function eventLink_(id) {
  const site = setting_('SITE_URL'), q = '?ev=' + encodeURIComponent(id);
  if (/^https:\/\/[^\s"'<>]+$/.test(site)) return site.replace(/\/$/, '') + '/' + q;
  let url = '';
  try { url = String(ScriptApp.getService().getUrl() || ''); } catch (e) { /* no web app yet */ }
  return url ? url + q : '';
}

/* The Post button for the Google Group and the Calendar. ev is the event as the page has it: it's saved first,
   under the lock, so the post always uses the current title, date and place, even for an event never saved before
   (the page sends created: true for one, as it does to saveEvent).
   The Posts row says it went out only once it did, so a second press says so instead of sending it twice.
   opts.by: who pressed it. opts.force: post again (Update calendar, or a test sent before going live).
   Returns { message, event }: the event as signIn reads it, with the Posts row and Activity line just written. */
function postTo(code, ev, channel, opts) {
  check_(code);
  opts = opts && typeof opts === 'object' ? opts : {};
  if (AUTO.indexOf(channel) < 0) throw new Error('That channel is copy and paste.');
  return writing_(() => {
    saveEvent_(ev);
    const id = String(ev.id || (ev.cols || {}).id);
    const e = readEvents_().find(r => r.cols.id === id);
    if (!e) throw new Error('Give the event a date first, then post.');
    // the Group can still get a cancellation notice; the Calendar entry came off when it was cancelled
    if (channel === 'calendar' && e.cols.status === 'cancelled') throw new Error('This event is cancelled, so it stays off the calendar.');
    const all = rows_('Posts', true), i = all.findIndex(r => r[0] === id && r[1] === channel);
    const row = i >= 0 ? all[i] : [], status = String(row[PCOL.status] || ''), sent = SENT.indexOf(status) >= 0, test = on_('TEST_MODE');
    // force on the Group is Post for real: only a test send, now that test mode is off. Pressed from a second tab,
    // or again after the Sheet didn't answer, the row says posted already, and the whole Group would get it twice.
    // (Update calendar is safe to repeat: it changes the one entry where it is.)
    const again = opts.force && (channel === 'calendar' || (status === 'test' && !test));
    if (sent && !again) throw new Error(channel === 'calendar' ? "Already posted. If the event changed, use Update calendar." : 'Already posted. To tell the Group about a change, use Draft an update.');
    if (sent && channel === 'calendar' && test && status === 'posted') throw new Error('Test mode is on, so the Guild calendar is left as it is. Turn TEST_MODE off on the Settings tab to update it.');
    if (!sent && status !== 'approved') throw new Error('Approve it first.');
    const c = e.cols, text = String(row[PCOL.text] || ''), by = short_(opts.by, 60);
    let message, calId = '', real = !test, updated = false;
    if (channel === 'ggroup') {
      const to = setting_('GROUP_EMAIL');
      if (!to && !test) throw new Error('Add the Google Group address on the Settings tab first.');
      const lines = text.split('\n'), first = lines[0] || '';
      const subject = /^subject:/i.test(first) ? first.replace(/^subject:\s*/i, '') : c.title + ', ' + niceDate_(c.date);
      const body = (/^subject:/i.test(first) ? lines.slice(1) : lines).join('\n').replace(/^\s+/, '');
      mail_(to || 'the Google Group', subject, body, 'post');
      message = test ? 'Test sent. Test mode is on, so the Google Group email went only to ' + owner_() + '.' : 'Emailed the Google Group.';
    } else {
      const tz = Session.getScriptTimeZone(), hm = t => /^\d{2}:\d{2}$/.test(t || '') ? t : '';
      const start = Utilities.parseDate(c.date + ' ' + (hm(c.start) || '10:00'), tz, 'yyyy-MM-dd HH:mm');
      const end = Utilities.parseDate(c.date + ' ' + (hm(c.end) || hm(c.start) || '12:00'), tz, 'yyyy-MM-dd HH:mm');
      const where = [c.place, c.address].filter(String).join(', ');
      // an earlier post of this event: updated where it is, so the calendar never gets a second copy
      const wasTest = status === 'test';
      let ce = sent ? calEvent_(calendar_(wasTest), row[PCOL['calendar id']]) : null;
      if (ce && wasTest && !test) { try { ce.deleteEvent(); } catch (er) { /* gone already */ } ce = null; } // going live: the test copy makes way
      if (ce) {
        real = !wasTest; updated = true;
        ce.setTime(start, end); ce.setTitle((real ? '' : '[TEST] ') + c.title); ce.setLocation(where); ce.setDescription(text);
      } else {
        ce = calendar_(test).createEvent((test ? '[TEST] ' : '') + c.title, start, end, { location: where, description: text });
      }
      calId = String(ce.getId());
      const name = (real ? calendar_(false).getName() : '') || 'the calendar';
      message = !real ? 'Test sent. Test mode is on, so it ' + (updated ? 'was updated' : 'went') + " on the Sheet owner's calendar, marked [TEST]."
        : (updated ? 'Updated on ' : 'Added to ') + name + '.';
    }
    // the Posts row: who, when, and the calendar event, so Update calendar changes this one
    const out = all[i].slice();
    out[PCOL.status] = real ? 'posted' : 'test'; out[PCOL['posted by']] = by; out[PCOL['posted at']] = new Date().toISOString();
    out[PCOL['calendar id']] = calId; out[PCOL.stale] = '';
    put_('Posts', i + 2, [out], ['status', 'posted by', 'posted at', 'calendar id', 'stale'].map(h => PCOL[h]));
    const note = real ? '' : channel === 'ggroup' ? ' (test mode: only the Sheet owner got it)' : " (test mode: on the Sheet owner's calendar)";
    append_('Activity', [[id, stamp_(), (by || 'An organizer') + (updated ? ' updated ' : ' posted to ') + AUTO_NAME[channel] + note]]);
    return { message: message, event: readAll_().events.find(r => r.cols.id === id) };
  });
}
/* Where calendar posts go: in test mode the owner's own calendar, else CALENDAR_ID (or the owner's when that's blank). */
function calendar_(test) {
  const id = setting_('CALENDAR_ID');
  return (!test && id && CalendarApp.getCalendarById(id)) || CalendarApp.getDefaultCalendar();
}
function calEvent_(cal, id) {
  if (!id) return null;
  try { return cal.getEventById(String(id)) || null; } catch (e) { return null; }
}
/* like the page's Activity times: "Oct 25 · 10:30 AM" */
function stamp_() {
  const tz = Session.getScriptTimeZone(), now = new Date();
  return Utilities.formatDate(now, tz, 'MMM d') + ' \u00b7 ' + Utilities.formatDate(now, tz, 'h:mm a');
}

/* Hourly trigger: reminders the evening before (6 PM on) and the morning of (8 AM to noon).
   A send that fails is logged as "failed: ..." under a key that doesn't count as sent, so it's tried again next
   hour, and the rest still go out. If any failed, the lead gets one email about it (once a day). */
function hourly() {
  // gardens added to the Sheet by hand get their map points, whether or not reminders are on
  try { if (locked_(geocodeGardens_)) dropPublic_(); } catch (e) { console.log('Gardens not looked up: ' + msg_(e)); }
  if (!on_('REMINDERS')) return 0;
  const tz = Session.getScriptTimeZone(), now = new Date();
  const hour = Number(Utilities.formatDate(now, tz, 'H'));
  const today = today_(), tomorrow = Utilities.formatDate(new Date(now.getTime() + 864e5), tz, 'yyyy-MM-dd');
  const team = readTeam_(), sent = new Set(rows_('Reminders').map(r => r[1]));
  const bringing = rows_('Bringing');
  const failed = [];
  const send = (key, to, subject, body, kind) => {
    try { mail_(to, subject, body, kind); return true; } catch (e) {
      const m = msg_(e);
      log_('failed|' + key, to, 'failed: ' + m);
      failed.push(subject + ' (to ' + to + '): ' + m);
      return false;
    }
  };
  let count = 0;
  readEvents_().forEach(({ cols: c }) => {
    if (c.status === 'cancelled') return; // nobody is bringing anything to an event that isn't happening
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
        if (send(key, p.contact, subject, 'Hi ' + p.name.split(' ')[0] + ",\n\nIt's the East Bay Permaculture Guild. You're on \"" + r[1] + '" for ' + c.title + ' ' + when + ".\n\nIf you can't make it, reply and we'll find someone. Thank you!", 'reminder')) {
          log_(key, p.contact, subject); count++;
        }
      } else toText.push([key, r[2] + (p && p.contact ? ' (' + p.contact + ')' : '') + ': ' + r[1]]);
    });
    if (toText.length) {
      const host = team.find(t => t.name === c.host), lead = team.find(t => t.role === 'lead');
      const to = [host, lead].map(t => t && t.contact).find(x => /@/.test(x || '')) || owner_();
      const subject = 'Text these people for ' + c.title;
      if (send([c.id, 'text list', kind].join('|'), to, subject, c.title + ' is ' + when + '.\nThese people have no email on the Team tab, so please text them a reminder:\n\n' + toText.map(x => '\u2022 ' + x[1]).join('\n'), 'text-list')) {
        toText.forEach(x => log_(x[0], to, subject)); count++;
      }
    }
  });
  const key = 'failed summary|' + today;
  if (failed.length && !sent.has(key) && quota_() > 0) {
    const to = leadEmail_() || owner_(), subject = "Some reminders didn't go out";
    try {
      mail_(to, subject, 'The Event Hub tried to send these reminders and Gmail said no:\n\n' + failed.map(x => '\u2022 ' + x).join('\n') +
        "\n\nIt will try again every hour while it's still time to remind people. Each one is on the Reminders tab of the Event Hub Sheet.", 'summary');
      log_(key, to, subject);
    } catch (e) { /* no quota left today: the failed rows are on the Reminders tab */ }
  }
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

/* pub: for getPublic, which reads only the Events, Team, Gardens and Settings tabs (so the volunteer and plant ids wait). */
function ensure_(pub) {
  const ss = book_();
  Object.keys(TABS).forEach(name => {
    if (ss.getSheetByName(name)) { addCols_(name); return; } // an update may have added columns
    const sh = ss.insertSheet(name), head = TABS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#E8F0DF');
    sh.setFrozenRows(1);
    if (asText_(name)) sh.getRange(2, 1, sh.getMaxRows() - 1, head.length).setNumberFormat('@');
    if (name === 'Events') sh.hideColumns(head.indexOf(DATA_HEAD) + 1);
    // only a tab made just now gets the Guild's channels: rows deleted or changed by hand later stay that way
    if (name === 'Channels') sh.getRange(2, 1, CHANNEL_ROWS.length, head.length).setValues(CHANNEL_ROWS);
  });
  if (!pub) { backfillVolIds_(); backfillPlants_(); } // rows typed in by hand get their ids
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
/* Every organizer call checks the code. A blank or short code lets nobody in. Wrong codes are counted per
   10 minutes; after 20 of them, every organizer call waits until the next 10 minutes, whatever code it brings. */
function check_(code) {
  const want = setting_('ORGANIZER_CODE');
  if (want.length < 8) throw new Error("The organizer code isn't set up yet. Ask the Sheet owner.");
  const cache = CacheService.getScriptCache(), key = 'fail:' + Math.floor(Date.now() / 6e5);
  const tries = Number(cache.get(key) || 0);
  const busy = () => new Error('Too many tries. Wait 10 minutes and try again.');
  if (tries > 20) throw busy();
  if (String(code == null ? '' : code).trim() === want) return;
  cache.put(key, String(tries + 1), 600);
  throw tries + 1 > 20 ? busy() : new Error("That organizer code isn't right.");
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

/* In test mode every email goes to the owner, with the real recipient in the subject. Replies go to REPLY_TO,
   or else the lead organizer. kind: what the email is ('welcome', 'reminder', ...); see CAN_WAIT.
   Returns false when an email that can wait was held back to save the day's quota (it's noted on the Reminders tab). */
function mail_(to, subject, body, kind) {
  if (!mailOk_(kind)) { log_(kind || 'email', to, 'skipped (quota): ' + subject); return false; }
  const test = on_('TEST_MODE'), opts = { name: 'East Bay Permaculture Guild' }, reply = replyTo_();
  if (reply) opts.replyTo = reply;
  MailApp.sendEmail(test ? owner_() : to, (test ? '[TEST to ' + to + '] ' : '') + subject, body, opts);
  return true;
}
/* Emails that can wait go out only while more than MAIL_RESERVE (30 when blank) are left for the day. */
function mailOk_(kind) {
  if (CAN_WAIT.indexOf(kind) < 0) return true;
  const typed = setting_('MAIL_RESERVE'), reserve = typed === '' || isNaN(Number(typed)) ? 30 : Number(typed);
  return quota_() > reserve;
}
function quota_() {
  try { return MailApp.getRemainingDailyQuota(); } catch (e) { return 0; }
}
function replyTo_() {
  const set = setting_('REPLY_TO');
  return /@/.test(set) ? set : leadEmail_();
}
/* the lead organizer's email on the Team tab, or '' */
function leadEmail_() {
  const lead = readTeam_().find(t => t.role === 'lead'), c = String((lead && lead.contact) || '').trim();
  return /@/.test(c) ? c : '';
}
function msg_(e) { return String((e && e.message) || e).replace(/^Exception:\s*/, '').slice(0, 300); }
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
/* An event's status, in the Events tab's status column. Draft: only organizers see it. Published: on the public page.
   Cancelled: shown as cancelled, and no reminders. Deleted: a draft deleted from the page; the row stays so no open
   page can bring it back, and every read skips it. A blank cell is published, so rows from before the column keep
   showing; a word the app doesn't know is a draft, so a typo never puts an event on the public page. */
function evStatus_(v) {
  const s = key_(v);
  if (!s || s === 'published') return 'published';
  if (s === 'deleted') return 'deleted';
  return s === 'cancelled' || s === 'canceled' ? 'cancelled' : 'draft';
}
/* An event row whose date can't be read is left out, and said so in `problems` (when given) so an organizer can fix it. */
function readEvents_(problems) {
  const out = [], dataAt = TABS.Events.indexOf(DATA_HEAD);
  rows_('Events', true).forEach((r, i) => {
    const cols = {};
    EV_COLS.forEach((k, j) => { cols[k] = r[j]; });
    if (!cols.id) return;
    if (!ID_RE.test(cols.id)) {
      if (problems) problems.push({ tab: 'Events', row: i + 2, what: 'the id can only use letters, numbers, - and _ (40 at most)' });
      return;
    }
    cols.status = evStatus_(r[TABS.Events.indexOf('status')]);
    if (cols.status === 'deleted') return; // a deleted draft's tombstone
    cols.date = normDate_(cols.date); cols.start = normTime_(cols.start); cols.end = normTime_(cols.end);
    cols.rsvp = postUrl_(r[TABS.Events.indexOf('rsvp link')]); // a link typed by hand that isn't https:// is left out
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
/* Published events from today on, soonest first, as the page lists them: today's go once their end time has passed,
   and a day with two is in start-time order. */
function upcoming_() {
  const t = today_(), now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm');
  const over = c => c.date === t && /^\d{2}:\d{2}$/.test(c.end || '') && c.end <= now;
  const at = c => c.date + ' ' + (c.start || '');
  return readEvents_().map(r => r.cols).filter(c => c.date >= t && c.status === 'published' && !over(c))
    .sort((a, b) => at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0);
}

/* Save one event as the page has it. A new row is added only when the page says the event is new (created: true,
   sent until its first save gets through; seed sends it too). Any other save of an id the Events tab doesn't have
   (its row deleted by hand, or its id cleared: the page sends created: false), or of a deleted draft, is refused, so a
   tab left open never brings back an event someone took out of the Sheet. A page from before created (it sends no
   created at all) can still add an event it just made, as long as the id was never deleted here: it would otherwise
   keep that event to itself, retrying every minute. A cancelled event stays cancelled: only a hand edit in the Sheet
   un-cancels it. */
function saveEvent_(p) {
  p = p || {};
  const c = Object.assign({}, p.cols || {}), id = String(p.id || c.id || '');
  if (!id) throw new Error('Event has no id.');
  if (!ID_RE.test(id)) throw new Error('An event id can only use letters, numbers, - and _ (40 at most).');
  (p.tasks || []).forEach(t => { if (!ID_RE.test(String((t && t.id) || ''))) throw new Error('A task id can only use letters, numbers, - and _ (40 at most).'); });
  (p.posts || []).forEach(x => { if (CHANNELS.indexOf(x && x.channel) < 0) throw new Error('Unknown channel.'); });
  const data = p.data && typeof p.data === 'object' && !Array.isArray(p.data) ? Object.assign({}, p.data) : {};
  data.id = id;
  if (data.photo !== undefined && PHOTOS.indexOf(data.photo) < 0) data.photo = 'none';
  if (data.map !== undefined && !/^https:\/\/\S+$/.test(String(data.map))) delete data.map;
  const tagOk = t => TAG_KEYS.indexOf(t) >= 0 || TAG_WORDS.test(t);
  if (data.tags !== undefined) data.tags = (Array.isArray(data.tags) ? data.tags : []).map(t => String(t).trim()).filter(tagOk);
  c.tags = String(c.tags == null ? '' : c.tags).split(',').map(t => t.trim()).filter(tagOk).join(', ');
  Object.keys(MAX_LEN).forEach(k => {
    if (c[k] != null) c[k] = String(c[k]).slice(0, MAX_LEN[k]);
    if (typeof data[k] === 'string') data[k] = data[k].slice(0, MAX_LEN[k]);
  });
  const all = rows_('Events', true), i = all.findIndex(r => r[0] === id), prev = i >= 0 ? all[i] : null;
  const ST = TABS.Events.indexOf('status'), RSVP = TABS.Events.indexOf('rsvp link'), DAT = TABS.Events.indexOf(DATA_HEAD);
  const had = prev ? evStatus_(prev[ST]) : '';
  if ((!prev && p.created !== true && p.created !== undefined) || had === 'deleted') throw new Error('This event was removed from the Sheet.');
  // status and RSVP link come from the page (in cols, or in the plan from an older page). A page that sends neither
  // leaves the Sheet's as they are, so a tab from before these columns can't publish a draft; a new event is a draft.
  // Deleted comes only from deleteEvent, and a cancelled event stays cancelled.
  const typed = v => v != null && String(v).trim() !== '';
  const asked = typed(c.status) ? evStatus_(c.status) : typed(data.status) ? evStatus_(data.status) : '';
  const status = had === 'cancelled' ? 'cancelled' : asked && asked !== 'deleted' ? asked : prev ? prev[ST] : 'draft';
  // a tab that hasn't seen the cancel yet: its edits are saved, but not its posts or activity, so the cancellation
  // notices and the line saying who cancelled it stay, and an old announcement can't come back to be posted
  const unaware = had === 'cancelled' && asked !== 'cancelled';
  const rsvp = c.rsvp !== undefined ? postUrl_(c.rsvp) : data.rsvp !== undefined ? postUrl_(data.rsvp) : prev ? prev[RSVP] : '';
  if (data.status !== undefined) data.status = evStatus_(status);
  if (data.rsvp !== undefined) data.rsvp = rsvp;
  // once on the public site, always known to have been (Delete draft is only for events nobody outside has seen)
  let before = {};
  try { before = prev ? JSON.parse(prev[DAT] || '{}') || {} : {}; } catch (e) { before = {}; }
  if (evStatus_(status) === 'published' || had === 'published' || before.wasPublished === true) data.wasPublished = true;
  else delete data.wasPublished;
  // a cell holds 50,000 characters; never cut the plan short, since a cut-off plan can't be read back
  const json = JSON.stringify(data);
  if (json.length > 45000) throw new Error("This event's plan is too long to save. Shorten the notes.");
  const row = [id].concat(EV_COLS.slice(1).map(k => c[k] == null ? '' : c[k]));
  row[TABS.Events.indexOf(DATA_HEAD)] = json;
  row[ST] = status; row[RSVP] = rsvp;
  if (i >= 0) put_('Events', i + 2, [row]);
  else append_('Events', [row]);
  replaceFor_('Bringing', id, (p.tasks || []).map(t => [id, t.what, t.who || '', t.status || '', t.id || '', t.last || '', taskType_(t.type)]));
  if (unaware) return;
  const postRows = rows_('Posts'), was = {}; // this event's Posts rows in the Sheet now, by channel
  postRows.forEach(r => { if (r[0] === id) was[r[1]] = r; });
  const posts = (p.posts || []).map(x => postRow_(id, x, was[x.channel]));
  // a Google Group email or Calendar entry that went out stays on the Posts tab, even from a page that never saw it
  AUTO.forEach(ch => { const w = was[ch]; if (w && SENT.indexOf(w[PCOL.status]) >= 0 && !posts.some(r => r[1] === ch)) posts.push(w); });
  replaceFor_('Posts', id, posts, postRows);
  replaceFor_('Activity', id, (p.log || []).slice(-100).map(l => [id, l[0], l[1]])); // the newest 100
}
/* One Posts row from the page. A Google Group or Calendar row the server sent ('posted', or 'test' in test mode)
   keeps its status, who posted it, when, the link and the calendar event, whatever the page says: a tab left open
   from before the post would otherwise bring the Post button back. The one way back to a draft is Draft an update,
   which names the post it replaces by its 'posted at' (redo; '-' when the Sheet has no time for it).
   The other way round too: only postTo marks them sent. A page that says sent when the Sheet doesn't (a tab from
   before Draft an update) leaves the Sheet's row as it is, so the update draft isn't lost.
   orig: a cancellation notice's link to the post it replaces ('original post'); a page that doesn't send it (one from
   before the column) leaves the Sheet's as it is. */
function postRow_(id, x, was) {
  const orig = x.orig !== undefined ? postUrl_(x.orig) : was ? postUrl_(was[PCOL['original post']]) : '';
  const row = [id, x.channel, x.status, short_(x.by, 60), x.text || '', x.edited ? 'yes' : '',
    short_(x.approvedBy, 60), short_(x.approvedAt, 40), short_(x.at, 40), postUrl_(x.url), '', x.stale ? 'yes' : '', orig];
  if (AUTO.indexOf(x.channel) < 0) return row;
  if (!was || SENT.indexOf(was[PCOL.status]) < 0) {
    if (SENT.indexOf(x.status) < 0) return row;
    if (was) return was.slice();
    // no row in the Sheet at all: a draft again, which needs approving before it can go
    row[PCOL.status] = 'review';
    ['posted by', 'approved by', 'approved at', 'posted at', 'post url', 'stale'].forEach(h => { row[PCOL[h]] = ''; });
    return row;
  }
  if (x.redo && String(x.redo) === (was[PCOL['posted at']] || '-') && SENT.indexOf(x.status) < 0) return row;
  ['status', 'posted by', 'posted at', 'post url', 'calendar id'].forEach(h => { row[PCOL[h]] = was[PCOL[h]]; });
  return row;
}
function short_(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
/* A task's type, as the page names it (food, tools, setup, other...): plain lowercase words only. */
function taskType_(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z-]/g, '').slice(0, 20); }
/* A link to a post on Partiful, Instagram and so on: kept only when it's a plain https:// link. */
function postUrl_(v) {
  const s = String(v == null ? '' : v).trim();
  return s.length <= 2000 && /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}
/* Bringing, Posts and Activity: swap one event's rows, keeping every other event's. all: the tab's rows, if just read. */
function replaceFor_(name, id, fresh, all) {
  const keep = (all || rows_(name)).filter(r => r[0] !== id);
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
/* A Volunteers row, in TABS order. 'contact' is kept filled (the email, else the phone) for anything that reads only it. */
function volRow_(v) {
  const c = String(v.contact || '').trim(), email = v.email || (/@/.test(c) ? c : ''), phone = v.phone || (email ? '' : c);
  return [v.date || today_(), v.name, email || phone, (v.help || []).join(', '), v.note || '', v.id || newVolId_(), email, phone,
    v.best || '', (v.free || []).join(', '), v.heard || '', v.list ? 'yes' : '', v.event || ''];
}
/* Sign-ups from before the id column, and rows added by hand, get a short id (one write for the whole column).
   all: the tab's rows with their places kept (rows_('Volunteers', true)), if just read. */
function backfillVolIds_(all) {
  all = all || rows_('Volunteers', true);
  const at = VCOL.id;
  if (!all.some(r => !String(r[at]).trim() && r.some(String))) return;
  put_('Volunteers', 2, all.map(r => { const out = []; out[at] = String(r[at]).trim() || (r.some(String) ? newVolId_() : ''); return out; }), [at]);
}

function readAll_() {
  const byEv = (name, f) => {
    const m = {};
    rows_(name).forEach(r => { (m[r[0]] = m[r[0]] || []).push(f(r)); });
    return m;
  };
  const tasks = byEv('Bringing', r => ({ what: r[1], who: r[2], status: r[3], id: r[4], last: r[5], type: r[6] }));
  const posts = byEv('Posts', r => ({ channel: r[1], status: r[2], by: r[3], text: r[4], edited: !!r[5], approvedBy: r[6], approvedAt: r[7], at: r[8], url: r[9], stale: !!r[11],
    orig: postUrl_(r[PCOL['original post']]) }));
  const log = byEv('Activity', r => [r[1], r[2]]);
  const problems = []; // rows an organizer needs to fix in the Sheet
  return {
    events: readEvents_(problems).map(e => {
      const ps = {};
      (posts[e.cols.id] || []).forEach(p => { ps[p.channel] = p; });
      return { data: e.data, cols: e.cols, tasks: tasks[e.cols.id] || [], posts: ps, log: log[e.cols.id] || [] };
    }),
    team: readTeam_(),
    vols: rows_('Volunteers').map(volOf_),
    gardens: readGardens_(),
    channels: readChannels_(),
    plants: readPlants_(problems),
    problems: problems,
  };
}
/* A Volunteers row for the organizers' Volunteer list. help and free are lists of the form's words. */
function volOf_(r) {
  const C = VCOL, list = v => String(v || '').split(',').map(x => x.trim()).filter(String), c = volContact_(r);
  return { date: normDate_(r[C['signed up']]), name: r[C.name], contact: r[C.contact] || c.email || c.phone, help: list(r[C['wants to help with']]), note: r[C.note],
    id: r[C.id], email: c.email, phone: c.phone, best: r[C['best way']], free: list(r[C.free]), heard: r[C['heard from']],
    list: /^(yes|true|x|1)$/i.test(String(r[C['email list']]).trim()), event: r[C.event] };
}
/* The Channels tab, as the page uses it: whether the Guild uses each channel, its name, the link its Open button goes to
   (https:// only) and whether new events start with it. A channel id the app doesn't know, and a second row for the same
   channel, are left out. TRUE, yes, x or 1 count as yes; anything else (a blank cell too) as no. */
function readChannels_() {
  // a Sheet from before this tab, signed in to before anything else made it (getPublic's cached answer skips ensure_)
  if (!sheet_('Channels')) {
    try { ensure_(); } catch (e) { /* made at the same moment by another call */ }
    if (!sheet_('Channels')) return [];
  }
  const yes = v => /^(true|yes|1|x|on)$/i.test(String(v).trim()), seen = {};
  return rows_('Channels').map(r => ({ id: key_(r[0]), name: short_(r[1], 60), used: yes(r[2]), link: postUrl_(r[3]), onNew: yes(r[4]) }))
    .filter(c => CHANNELS.indexOf(c.id) >= 0 && !seen[c.id] && (seen[c.id] = true));
}
/* Every garden with a name. lat and lng are null until the hourly run finds them, or when it couldn't ('not found'):
   the garden is still in the list, just not on the map. */
function readGardens_() {
  const num = v => { const t = String(v == null ? '' : v).trim(), n = Number(t); return t && !isNaN(n) ? n : null; };
  return rows_('Gardens').map(r => ({ name: r[0], addr: r[1], what: r[2], lat: num(r[3]), lng: num(r[4]) })).filter(g => g.name);
}
/* Fill in lat/lng for gardens added by hand, five at a time, using Google's free geocoder (from hourly and seed).
   An address it can't find gets 'not found' in the lat cell, so it isn't looked up every hour; clear that cell, or fix
   the address and clear it, to try again. When the geocoder doesn't answer, the row is tried next hour.
   Returns how many rows it filled in. */
function geocodeGardens_() {
  const todo = rows_('Gardens', true).map((r, i) => [r, i]).filter(x => x[0][0] && String(x[0][1]).trim() && !String(x[0][3]).trim());
  let n = 0;
  todo.slice(0, 5).forEach(([r, i]) => {
    let res;
    try { res = Maps.newGeocoder().geocode(r[1]); } catch (e) { return; }
    const hit = res && res.results && res.results[0], loc = hit && hit.geometry && hit.geometry.location;
    if (!loc && res && res.status && res.status !== 'ZERO_RESULTS') return; // over the limit or an error: next hour
    put_('Gardens', i + 2, [[r[0], r[1], r[2], loc ? String(loc.lat) : 'not found', loc ? String(loc.lng) : '']], [3, 4]);
    n++;
  });
  return n;
}
