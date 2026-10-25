/* live mode: the page talks to the Google Sheet through Apps Script */
if (window.EBPG_GAS) {
  const G = window.EBPG_GAS;
  // A call that fails on the way (no connection, a timeout, an HTML error page from Google) says this.
  // Saves keep retrying; other calls put it in their own words.
  const NO_ANSWER = "The Guild Sheet didn't answer. We'll keep trying.";
  const noAnswer = () => Object.assign(new Error(NO_ANSWER), { net: true });
  let leaving = false; // set while the page is closing, so its last saves go out with keepalive
  // On Netlify the page calls the Apps Script web app's JSON API; inside Google it uses google.script.run.
  // text/plain keeps the request "simple", so the browser sends it without a CORS preflight.
  // A call gets 30 seconds (see LIMIT). Only a JSON answer counts: Apps Script sometimes answers with an HTML error page.
  async function post(fn, args, ms) {
    const body = JSON.stringify({ fn, args });
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ac && setTimeout(() => ac.abort(), ms);
    let out;
    try {
      const r = await fetch(G.api, { method: 'POST', body, keepalive: leaving && body.length < 60000, signal: ac ? ac.signal : undefined });
      const type = (r.headers && r.headers.get('content-type')) || '';
      if (!r.ok || !/json/i.test(type)) throw noAnswer();
      out = await r.json();
    } catch { throw noAnswer(); } finally { clearTimeout(t); }
    if (!out || typeof out !== 'object') throw noAnswer();
    if (out.error) throw new Error(out.error);
    return out.value;
  }
  const viaGoogle = (fn, args, ms) => new Promise((ok, no) => {
    const t = setTimeout(() => no(noAnswer()), ms);
    google.script.run
      .withSuccessHandler(v => { clearTimeout(t); ok(v); })
      .withFailureHandler(e => {
        clearTimeout(t);
        const m = String((e && e.message) || e).replace(/^Exception:\s*/, '');
        no(/^NetworkError|HTTP \d+|^ScriptError/.test(m) ? noAnswer() : new Error(m));
      })[fn](...args);
  });
  // A sleeping Apps Script can be slow to start, so signing in gets 45 seconds, and filling an empty Sheet
  // (every starter event written under the lock) gets 90.
  const LIMIT = { signIn: 45000, seed: 90000 };
  const run = (fn, ...a) => G.api ? post(fn, a, LIMIT[fn] || 30000) : viaGoogle(fn, a, LIMIT[fn] || 30000);

  // The organizer code: kept for this tab, or on this device for 30 days when "Remember this device" is ticked.
  const REM = 'ebpg-remember', DAYS30 = 30 * 864e5;
  const store = {
    kept() {
      try {
        const k = JSON.parse(localStorage.getItem(REM) || 'null');
        if (k && k.code && k.until > Date.now()) return k;
        if (k) localStorage.removeItem(REM);
      } catch {}
      return {};
    },
    code() {
      try { const c = sessionStorage.getItem('ebpg-code'); if (c) return c; } catch {}
      return store.kept().code || '';
    },
    // remember: true keeps it on this device, false forgets the device, undefined leaves the device as it was
    keep(c, name, remember) {
      try { sessionStorage.setItem('ebpg-code', c); } catch {}
      try {
        if (remember) localStorage.setItem(REM, JSON.stringify({ code: c, name, until: Date.now() + DAYS30 }));
        else if (remember === false) localStorage.removeItem(REM);
      } catch {}
    },
    clear() {
      try { sessionStorage.removeItem('ebpg-code'); } catch {}
      try { localStorage.removeItem(REM); } catch {}
    },
  };
  let code = store.code(), live = false;

  // event <-> rows
  const split = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  const payload = ev => {
    const { tasks, log, posts, isNew, created, ...data } = ev, pl = ev.plan; // created goes with a save, not in the plan
    return {
      id: ev.id, data,
      cols: { label: ev.label || '', title: ev.title, date: ev.date, start: ev.start, end: ev.end, place: ev.place, address: ev.address || '', host: hostOf(pl), cohosts: cohostsOf(pl).join(', '),
        about: ev.about || '', bring: ev.bring || '', tags: ev.tags.join(', '), notes: (pl.notes || []).join('\n'), timeline: PT.timeline(pl),
        status: ev.status || '', rsvp: ev.rsvp || '' }, // a blank status leaves the Sheet's as it is
      tasks: (tasks || []).map(t => ({ id: t.id, what: t.text, who: t.who || '', status: t.status || '', last: t.last || '', type: taskType(t.type) })),
      posts: CHANNELS.filter(c => posts[c.id] && posts[c.id].status !== 'off').map(c => {
        const q = posts[c.id];
        // stale: the title, date, time or place changed since it went out. redo: Draft an update names the post it replaces
        // orig: a cancellation notice's link to the post it replaces (the Partiful event to cancel there)
        return { channel: c.id, status: q.status, by: q.by || '', text: q.text, edited: !!q.edited, approvedBy: q.approvedBy || '', approvedAt: q.approvedAt || '', at: q.at || '', url: q.url || '',
          stale: !!q.stale, ...(q.redo ? { redo: q.redo } : {}), ...(q.orig ? { orig: q.orig } : {}) };
      }),
      log: log || [],
    };
  };
  const ID_OK = /^[A-Za-z0-9_-]{1,40}$/; // the ids the Sheet accepts (ID_RE in Code.js)
  const BLANK_PLAN = () => ({ leadStart: '', leadEnd: '', leadNote: '', roles: [], pending: [], setup: [], supplies: [], food: null, timeline: [], icebreaker: '', questions: [], notes: [], areas: [], debrief: [] });
  /* Is a draft's text in the Posts tab still the one the app wrote? It is when it's what the app writes for the event
     as this page last saved it (r.data, so a time typed into the Events tab since doesn't count as a hand edit), or for
     the event as the Sheet has it now. A draft of an unpublished event that has the event page's link also counts: an
     earlier version of the page wrote those. Anything else was changed by hand in the Sheet. */
  function appsText(id, r, ev, p) {
    const was = Object.assign({ tags: [], host: '' }, r.data, { id: ev.id });
    const ways = [ev, was, Object.assign({}, was, { status: 'published' })];
    try { return ways.some(e => freshText(id, e, p) === p.text); } catch { return false; } // a row typed by hand may lack a field
  }
  function fromRows(r) {
    const c = r.cols, ev = Object.assign({ tags: [], photo: 'trellis' }, r.data);
    ev.plan = Object.assign(BLANK_PLAN(), ev.plan || {});
    const pl = ev.plan;
    Object.assign(ev, { id: c.id, label: c.label, title: c.title, date: c.date, start: c.start, end: c.end, place: c.place, address: c.address, about: c.about, bring: c.bring,
      status: c.status == null || c.status === '' ? 'published' : EV_STATUS[c.status] ? c.status : 'draft', rsvp: safeUrl(c.rsvp) }); // as the Sheet reads it: blank is published
    if (split(c.tags).join(',') !== ev.tags.join(',')) ev.tags = split(c.tags);
    // hand edits in the Sheet win; untouched cells keep the richer saved plan. The co-hosts cell may still say what pages
    // before the plan's other roles were kept apart wrote there (everyone in every role), which isn't a hand edit.
    // A hand edit changes the Host and Co-hosts roles only; the other roles stay.
    if (c.host !== hostOf(pl) || (c.cohosts !== cohostsOf(pl).join(', ') && c.cohosts !== everyoneBut(pl).join(', '))) pl.roles = withHosting(pl, c.host, split(c.cohosts));
    if (c.notes !== (pl.notes || []).join('\n')) pl.notes = lns(c.notes);
    if (c.timeline !== PT.timeline(pl)) pl.timeline = parseTimeline(c.timeline);
    ev.host = hostOf(pl) || ev.host || '';
    // a task id typed by hand that the Sheet wouldn't take back gets a new one; a type it doesn't know is 'other', and a
    // status typed by hand ('Confirmed', "Can't make it") reads as the app's own (blank: asked once someone's on it)
    ev.tasks = r.tasks.map(t => Object.assign(mkTask(t.type, t.what, t.who, taskStatus(t.status, t.who)), ID_OK.test(t.id || '') ? { id: t.id } : {}, t.last ? { last: t.last } : {}));
    ev.posts = {};
    CHANNELS.forEach(ch => {
      const p = r.posts[ch.id], st = p && STATUS[p.status] ? p.status : 'review';
      // a draft nobody edited, still waiting for review, is written again from the event as the Sheet has it now
      // (an RSVP link or a new time typed into the Events tab by hand), but only while its text in the Posts tab is still
      // the app's own. A draft fixed by hand there keeps its text, and counts as edited from now on, so nothing writes
      // over it. Approved and posted texts stay as they are.
      const review = !!p && st === 'review' && !!p.text && !p.edited, mine = review && appsText(ch.id, r, ev, p);
      const text = mine ? freshText(ch.id, ev, p) : (p && p.text) || draft(ch.id, ev);
      // who approved it and when, and who posted it, when and where: the Posts tab's own columns
      ev.posts[ch.id] = p ? { status: st, text, edited: !!p.edited || (review && !mine),
        by: p.by || '', approvedBy: p.approvedBy || '', approvedAt: p.approvedAt || '', at: p.at || '', url: safeUrl(p.url), stale: !!p.stale, open: false,
        ...(safeUrl(p.orig) ? { orig: safeUrl(p.orig) } : {}) }
        : { status: 'off', text: draft(ch.id, ev), edited: false, ...NO_TRAIL, open: false };
    });
    ev.log = r.log;
    return ev;
  }
  /* An event for the public page, from getPublic's public fields only (no plan notes, tasks, posts or activity):
     just enough for the landing page's cards, with the rest left empty so nothing that draws an event trips on it. */
  function fromPublic(e) {
    const s = v => String(v ?? ''), host = s(e.host);
    const ev = { id: s(e.id), series: s(e.type), num: 0, label: s(e.label), title: s(e.title), date: s(e.date), start: s(e.start), end: s(e.end),
      place: s(e.place), address: s(e.address), map: safeUrl(e.map), about: s(e.about), bring: s(e.bring), tags: Array.isArray(e.tags) ? e.tags.map(s) : [],
      photo: s(e.photo), host, status: 'published', rsvp: safeUrl(e.rsvp) };
    ev.plan = Object.assign(BLANK_PLAN(), { roles: [['Host', host ? [host] : []]], timeline: (Array.isArray(e.timeline) ? e.timeline : []).map(r => [s(r && r[0]), s(r && r[1]), '']) });
    ev.tasks = []; ev.log = []; ev.posts = {};
    CHANNELS.forEach(ch => { ev.posts[ch.id] = { status: 'off', text: '', edited: false, ...NO_TRAIL, open: false }; });
    return ev;
  }
  /* the Settings the public page shows. They come with every public answer and are nobody's edits, so they're kept
     signed in too (the garden sign on Flyers & posts uses WORKDAY_SCHEDULE) */
  function pubSettings(set) {
    set = set || {};
    PUB.SCHEDULE_TEXT = String(set.SCHEDULE_TEXT ?? '').trim();
    PUB.LINKTREE_URL = safeUrl(set.LINKTREE_URL) || LINKTREE;
    if (set.WORKDAY_SCHEDULE != null) PUB.WORKDAY_SCHEDULE = String(set.WORKDAY_SCHEDULE).trim();
  }
  // names and roles only: what each person can do comes with signing in
  const namesOnly = team => (Array.isArray(team) ? team : []).map(t => ({ name: String(t?.name ?? ''), role: ROLE[t?.role] ? t.role : 'vol', contact: '', via: '', perms: allPerms(false) }));
  /* signed out: the Sheet's public view, and nothing else. A Sheet nobody has set up yet has no events and no
     organizers, and the page says so; the Guild's starter plans in this file are only for filling it (SEED). */
  function loadPublic(st) {
    if (!st || !Array.isArray(st.events)) return false;
    EVENTS.length = 0; st.events.forEach(e => EVENTS.push(fromPublic(e)));
    CANCELLED.clear(); (Array.isArray(st.cancelled) ? st.cancelled : []).forEach(id => CANCELLED.add(String(id).slice(0, 40)));
    TEAM.splice(0, TEAM.length, ...namesOnly(st.team));
    if (st.gardens?.length) GARDENS.splice(0, GARDENS.length, ...st.gardens);
    pubSettings(st.settings);
    if (!EVENTS.find(e => e.id === S.sel)) S.sel = nextEvent()?.id;
    pubState = 'ready';
    return true;
  }
  /* The last public data the Sheet sent, kept on this device so the next visit shows it at once (then reads the
     Sheet again). Public data only: getPublic's answer, which has no plans, contacts or codes. */
  const PUBLIC_CACHE = 'ebpg-public-v1';
  const cached = () => {
    try { const c = JSON.parse(localStorage.getItem(PUBLIC_CACHE) || 'null'); return c && c.st && Array.isArray(c.st.events) ? c.st : null; } catch { return null; }
  };
  const keepPublic = st => { try { localStorage.setItem(PUBLIC_CACHE, JSON.stringify({ at: Date.now(), st })); } catch {} };
  const snapEv = ev => JSON.stringify(payload(ev));
  const snapTeam = () => JSON.stringify(TEAM.map(({ name, role, contact, via, perms }) => ({ name, role, contact, via, perms })));
  const vols = list => list.map(v => ({ ...v, help: v.help.map(l => (HELP.find(h => h[1].toLowerCase() === l.toLowerCase()) || [l])[0]) }));

  /* ---------- saving ----------
     Each event, and the team, is a save "key". saved[key] is what the Sheet has as far as this page knows,
     base[key] the Sheet's own rows as last read. One save per key is out at a time; when it comes back,
     only the newest version goes next. A failed save is retried after 2 s, 5 s, 15 s, then every 60 s. */
  const saved = {}, base = {}, touched = {};
  let Q = {}, mine = new Set(), waits = [], gen = 0, timer = 0, retryTimer = 0, tries = 0, manual = false, failShown = false;
  /* The organizer code changed (or was cleared) on the Settings tab while this page was open. Trying again can't
     help, and every try counts as a wrong code (20 in 10 minutes pause sign-in for everyone). So the page stops
     calling the Sheet, keeps its changes, and asks for the new code; signing in with it sends them (see remote.signIn). */
  let stale = false;
  const CODE_GONE = /organizer code isn't (right|set up yet)/;
  const codeGone = er => !!er && !er.net && CODE_GONE.test(er.message);
  const STALE = 'The organizer code was changed. Sign in again with the new code, and your changes here will be saved.';
  const WAIT = [2000, 5000, 15000, 60000];
  const keyOf = ev => 'e:' + ev.id;
  const snapOf = k => {
    if (k === 'team') return snapTeam();
    const ev = EVENTS.find(e => keyOf(e) === k);
    return ev && !ev.isNew ? snapEv(ev) : null;
  };
  const keys = () => EVENTS.filter(e => !e.isNew).map(keyOf).concat('team');
  const dirty = k => { const s = snapOf(k); return s != null && s !== saved[k]; };
  const busy = k => !!(Q[k] && Q[k].busy);
  const failedKeys = () => keys().filter(k => Q[k] && Q[k].failed);
  unsaved = id => !!(Q['e:' + id] && Q['e:' + id].failed);

  function send(k) {
    const q = Q[k] || (Q[k] = { busy: false, failed: false, err: null });
    if (q.busy) return; // the newest version goes when this save is back
    const s = snapOf(k);
    if (s == null) { delete Q[k]; return; }
    if (s === saved[k]) { q.failed = false; return; }
    if (stale) { q.failed = true; return; } // kept here until signed in with the new code
    q.busy = true; touched[k] = Date.now();
    const g = gen, ev = k === 'team' ? null : EVENTS.find(e => keyOf(e) === k), body = JSON.parse(s);
    // new: the Sheet adds its row (only then, so nothing it lost comes back). Always said, either way: a save that
    // doesn't say is from a page older than this, which the Sheet still lets add the events it makes
    if (ev) body.created = !!ev.created;
    run(k === 'team' ? 'saveTeam' : 'saveEvent', code, body)
      .then(() => { if (g !== gen) return; saved[k] = s; q.failed = false; q.err = null; mine.add(k); if (ev) delete ev.created; },
        er => { if (g !== gen) return; q.failed = true; q.err = er; })
      .then(() => {
        if (g !== gen) return;
        q.busy = false; touched[k] = Date.now();
        if (q.failed && removed(q.err)) {
          waits = []; // its "Saved" won't come
          dropRemoved(k); status();
          if (chipState === 'saved') chip('idle'); // not "All changes saved" right after one that couldn't be
          return;
        }
        if (q.failed) { if (codeGone(q.err)) staleCode(); else if (!stale) { retryLater(); noteFailure(q.err); } }
        else if (!timer && dirty(k)) send(k); // changes made while it was out
        status();
      });
  }
  /* An event someone took out of the Sheet (its row deleted, its id cleared, or deleted from another tab): the Sheet
     turns down saving it, so it goes from this page too, with a note saying so. Returns the note. */
  const removed = er => !!er && !er.net && /removed from the Sheet/.test(er.message);
  function forget(k) { delete Q[k]; delete saved[k]; delete base[k]; delete touched[k]; mine.delete(k); }
  function dropRemoved(k) {
    forget(k);
    const i = EVENTS.findIndex(e => keyOf(e) === k), ev = i >= 0 ? EVENTS.splice(i, 1)[0] : null;
    const msg = `${(ev && (ev.label || ev.title)) || 'This event'} was removed from the Guild Sheet, so your change wasn't saved and it's gone from this page.`;
    if (!ev) return msg;
    if (S.sel === ev.id) { leaveEvent(); S.sel = nextEvent()?.id; }
    render(); renderMaterials();
    toast(msg, 'alert-triangle');
    return msg;
  }
  // a save of this key on its way: wait for it (up to 30 seconds), so a call after it has the last word
  const settled = k => new Promise(ok => { const t0 = Date.now(), go = () => !busy(k) || Date.now() - t0 > 30000 ? ok() : setTimeout(go, 50); go(); });
  function flush() {
    clearTimeout(timer); timer = 0;
    if (!live) return;
    keys().forEach(send);
    status();
  }
  function retryLater() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = 0; flush(); }, WAIT[Math.min(tries++, WAIT.length - 1)]);
  }
  function retryNow(byHand) {
    clearTimeout(retryTimer); retryTimer = 0;
    if (byHand) manual = true; // the chip says Saving… until it's back (a retry on its own doesn't undo that)
    flush();
  }
  function noteFailure(er) {
    waits = []; // their "Saved" won't come; the chip says "Not saved" instead
    if (failShown) return;
    failShown = true;
    toast(!er || er.net ? NO_ANSWER : "Not saved. " + er.message, 'alert-triangle');
  }
  // the Sheet turned down this page's code: stop calling it, say so once, and go to the sign-in card
  // (unless an event pop-up is open or something is being typed: then the toast and the chip say it)
  function staleCode() {
    if (stale || !live) return;
    stale = true; waits = [];
    clearTimeout(timer); clearTimeout(retryTimer); timer = retryTimer = 0;
    status();
    const err = $('#si-err'), a = document.activeElement;
    err.textContent = STALE; err.hidden = false;
    $('#si-code').value = '';
    if ($('#modal').hidden && !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) { goSignIn(); $('#si-code').focus(); }
    else toast('The organizer code was changed. Sign in again with the new code.', 'alert-triangle');
  }
  // the chip's Sign in again: close the pop-up, and ask for the new code
  function signInAgain() {
    if (!$('#modal').hidden) closeEvent();
    $('#si-err').textContent = STALE; $('#si-err').hidden = false;
    goSignIn(); $('#si-code').focus();
  }
  // save whatever changed, a moment after it changed
  sync = () => { if (!live) return; clearTimeout(timer); timer = setTimeout(flush, 800); status(); };
  whenSaved = f => {
    if (!live) return f();
    waits.push(f);
    // saving again while earlier saves are failing tries them all now, so the chip says Saving…, then how it went
    if (failedKeys().length) retryNow(true); else sync();
  };

  /* the status chip: one in the top bar (#savest), and one in the event pop-up's bar (#m-savest), since the
     page behind an open pop-up is inert. Only one can be seen or heard at a time. */
  const CHIP = { saving: ['loader', 'Saving…'], saved: ['check', 'All changes saved'], failed: ['alert-triangle', 'Not saved'], stale: ['alert-triangle', 'Not saved'] };
  let chipState = 'idle', fadeT = 0, failedIds = '';
  function chip(st) {
    if (st === chipState) return;
    clearTimeout(fadeT);
    chipState = st;
    $$('.savest').forEach(el => {
      const btn = el.querySelector('button'), hadFocus = document.activeElement === btn;
      el.classList.remove('fade'); el.dataset.state = st;
      el.firstElementChild.innerHTML = CHIP[st] ? ic(CHIP[st][0]) + esc(CHIP[st][1]) : '';
      const [bi, bt] = st === 'stale' ? ['log-in', 'Sign in again'] : ['rotate-ccw', 'Retry'];
      if (btn.textContent !== bt) btn.innerHTML = ic(bi) + esc(bt);
      btn.hidden = st !== 'failed' && st !== 'stale';
      if (hadFocus && btn.hidden) el.focus(); // keep keyboard focus nearby while it retries
    });
    if (st === 'saved') fadeT = setTimeout(() => { $$('.savest').forEach(el => el.classList.add('fade')); fadeT = setTimeout(() => chip('idle'), 650); }, 3000);
  }
  function status() {
    const ks = keys(), out = ks.some(busy), bad = failedKeys();
    if (!out) manual = false;
    let st;
    if (!live) st = 'idle';
    else if (stale && (bad.length || ks.some(dirty))) st = 'stale';
    else if (bad.length && !manual) st = 'failed';
    else if (out || ks.some(dirty)) st = 'saving';
    else st = chipState === 'idle' ? 'idle' : 'saved';
    if (st === 'failed' || st === 'stale') waits = [];
    if (st === 'idle' || st === 'saved') {
      failShown = false; tries = 0; clearTimeout(retryTimer); retryTimer = 0;
      const w = waits; waits = []; w.forEach(f => f());
    }
    chip(st);
    const ids = bad.filter(k => k !== 'team').sort().join(',');
    if (ids !== failedIds) { failedIds = ids; markUnsaved(); }
  }
  $$('.savest button').forEach(b => b.addEventListener('click', () => stale ? signInAgain() : retryNow(true)));
  window.addEventListener('online', () => { if (live && !stale && failedKeys().length) retryNow(false); });
  // closing the tab: send what's left; if anything still isn't saved, the browser asks first
  window.addEventListener('beforeunload', e => {
    if (!live) return;
    leaving = true; commitDeletes(true); flush(); leaving = false; // a draft deleted in the last 10 seconds goes now
    if (keys().some(k => busy(k) || dirty(k)) || failedKeys().length) { e.preventDefault(); e.returnValue = 'Some changes are not saved yet.'; }
  });

  /* ---------- reading the Sheet ---------- */
  // this page's own address: event links (?ev=) in posts, on flyers and for sharing, and the garden sign's QR code
  evLink = id => G.url ? G.url + '?ev=' + encodeURIComponent(id) : '';
  siteLink = hash => G.url ? G.url + hash : '';
  // the starter drafts were written before the page knew its address, so they're written again with each event's link
  EVENTS.forEach(ev => CHANNELS.forEach(c => { const q = ev.posts[c.id]; if (q && !q.edited) q.text = draft(c.id, ev); }));
  // the first sign-in fills an empty Sheet with this: the Guild's real plans, the team with contacts still blank, and no volunteers
  const SEED = { events: EVENTS.map(e => ({ ...payload(e), created: true })), team: JSON.parse(JSON.stringify(TEAM)), vols: [], gardens: GARDENS.slice() };
  // ...and nothing else uses them: every page shows only what the Sheet sends
  EVENTS.length = 0; TEAM.length = 0; S.sel = undefined;
  pubState = 'loading'; pubAnswered = false; // an event's page waits for the Sheet before it says an event isn't there
  function load(st) {
    applyChannels(st.channels); // the Channels tab: which ones the Guild uses, their names and links
    EVENTS.length = 0; st.events.forEach(r => EVENTS.push(fromRows(r))); // the public copies go: these are the Sheet's own rows
    if (st.team?.length) TEAM.splice(0, TEAM.length, ...st.team);
    if (st.vols) VOLS.splice(0, VOLS.length, ...vols(st.vols));
    if (st.gardens?.length) GARDENS.splice(0, GARDENS.length, ...st.gardens);
    takePlants(st.plants || []); basePlants = JSON.stringify(st.plants || []);
    problems = st.problems || []; // only signIn and seed send these, so the public page never has any
    taskSeq = Math.max(taskSeq, ...EVENTS.flatMap(e => e.tasks.map(t => +String(t.id).replace(/\D/g, '') || 0)));
    EVENTS.forEach(e => { saved[keyOf(e)] = snapEv(e); });
    saved.team = snapTeam();
    st.events.forEach(r => { base['e:' + r.cols.id] = JSON.stringify(r); });
    base.team = JSON.stringify(st.team || []); base.vols = JSON.stringify(st.vols || []);
    if (!EVENTS.find(e => e.id === S.sel)) S.sel = nextEvent()?.id;
    pubState = 'ready'; pubAnswered = true; // the landing page now draws from the Sheet's own rows (published ones only)
  }
  // start over: a new sign-in, or signing out
  function reset() {
    gen++; Q = {}; mine = new Set(); waits = []; tries = 0; manual = false; failShown = false; stale = false;
    clearTimeout(timer); clearTimeout(retryTimer); timer = retryTimer = 0;
    [saved, base, touched].forEach(o => Object.keys(o).forEach(k => delete o[k]));
    chip('idle'); failedIds = '';
  }

  /* Coming back to the tab, and every 2 minutes while it's open, read the Sheet again. Events and the team
     take what's there unless they have changes of their own here, or are being edited. */
  let reading = false, lastRead = 0;
  async function refresh(force) {
    if (!live || stale || reading || document.hidden) return;
    if (!force && Date.now() - lastRead < 10000) return;
    reading = true;
    const g = gen, t0 = Date.now();
    lastRead = t0;
    try {
      const st = await run('signIn', code);
      if (g === gen && live) testBar(st); // TEST_MODE may have been turned off on the Settings tab
      if (g === gen && live && !st.empty && merge(st, t0)) toast('Updated with the latest changes', 'check');
      // the Sheet is answering again: send what didn't go through now, not at the next retry (up to a minute away)
      if (g === gen && live && failedKeys().length) retryNow(false);
    } catch (er) { if (g === gen && codeGone(er)) staleCode(); } finally { reading = false; }
  }
  function merge(st, t0) {
    const open = $('#detail') ? S.sel : null;
    const typing = () => { const a = document.activeElement; return !!(a && a.closest && a.closest('#detail') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
    // a save that started or ended after this read began may be newer than what the read saw
    const held = k => dirty(k) || busy(k) || !!(Q[k] && Q[k].failed) || touched[k] >= t0;
    const editing = ev => ev.id === open && (S.editing || typing());
    let news = false, evs = false, openRedo = false, team = false, vl = false, pl = false;
    const seen = new Set();
    st.events.forEach(r => {
      const id = r.cols.id, k = 'e:' + id, raw = JSON.stringify(r);
      seen.add(id);
      if (base[k] === raw || DELETING.has(id)) return; // a draft deleted here, waiting for Undo, stays out
      const i = EVENTS.findIndex(e => e.id === id), cur = EVENTS[i];
      if (cur && (cur.isNew || held(k) || editing(cur))) return;
      const fresh = fromRows(r), s = snapEv(fresh), ours = mine.delete(k);
      base[k] = raw; saved[k] = s;
      if (cur && s === snapEv(cur)) return; // the Sheet has what this page shows
      // what only this page knows about a post stays: a draft being read, and the RSVP question nobody has answered yet
      // (the row still shows it only while that post is posted with its link and the event has no RSVP link)
      if (cur) { CHANNELS.forEach(c => { const q = cur.posts[c.id], f = fresh.posts[c.id]; if (q && f) { if (q.open) f.open = true; if (q.askRsvp) f.askRsvp = true; } }); EVENTS[i] = fresh; }
      else EVENTS.push(fresh);
      evs = true; if (!ours) news = true; if (id === open) openRedo = true;
    });
    // an event taken out of the Sheet by hand goes here too, unless it has changes of its own or is open
    for (let i = EVENTS.length - 1; i >= 0; i--) {
      const e = EVENTS[i], k = keyOf(e);
      if (seen.has(e.id) || !base[k] || e.isNew || e.id === open || held(k)) continue;
      EVENTS.splice(i, 1); delete base[k]; delete saved[k]; delete Q[k];
      evs = news = true;
    }
    const rawTeam = JSON.stringify(st.team || []);
    // (not while someone's contact is being changed on the Team page: that waits for the next read)
    if (st.team?.length && rawTeam !== base.team && !held('team') && !S.pedit) {
      const before = snapTeam(), ours = mine.delete('team');
      TEAM.splice(0, TEAM.length, ...st.team);
      base.team = rawTeam; saved.team = snapTeam();
      if (saved.team !== before) { team = true; if (!ours) news = true; }
    }
    const rawVols = JSON.stringify(st.vols || []), ourVols = mine.delete('vols'); // a sign-up from this page isn't news here
    if (st.vols && rawVols !== base.vols) { base.vols = rawVols; VOLS.splice(0, VOLS.length, ...vols(st.vols)); vl = true; if (!ourVols) news = true; }
    // the plants, unless a change from here is on its way or came back after this read began (then it's newer)
    const rawPlants = JSON.stringify(st.plants || []);
    if (Array.isArray(st.plants) && rawPlants !== basePlants && !PL_BUSY.size && plantsAt < t0) { basePlants = rawPlants; takePlants(st.plants); pl = news = true; }
    problems = st.problems || [];
    renderProblems();
    // the Channels tab changed: the attention bar, and the open event unless something in it is being typed
    if (applyChannels(st.channels)) { news = evs = true; renderHelp(); if (open && !S.editing && !typing()) openRedo = true; }
    if (evs) {
      taskSeq = Math.max(taskSeq, ...EVENTS.flatMap(e => e.tasks.map(t => +String(t.id).replace(/\D/g, '') || 0)));
      const ft = document.activeElement?.closest?.('#tiles [data-open]')?.dataset.open;
      renderAttn(); renderTiles(); renderMaterials(); redrawLanding();
      if (ft) $$('#tiles [data-open]').find(t => t.dataset.open === ft)?.focus();
      if (openRedo) renderDetail();
    }
    if (team) { renderAs(); renderTeam(); }
    if (vl) renderVols();
    if (pl) renderPlants();
    // the open event's Who lists, Ask links and reminder lines go by the team and the sign-ups
    if ((team || vl) && open && !openRedo && !S.editing && !typing()) renderDetail();
    status();
    return news;
  }
  setInterval(() => refresh(true), 120000);
  document.addEventListener('visibilitychange', () => {
    if (!live || stale) return;
    // a phone may close the page without warning, so its saves go now. A draft deleted a moment ago keeps its
    // 10 seconds to Undo: glancing at another tab or app shouldn't take them away (its timer goes on meanwhile)
    if (document.hidden) { leaving = true; flush(); leaving = false; }
    else { if (failedKeys().length) retryNow(false); refresh(); } // back on the tab: try failed saves again now
  });
  // the page really going (closed, reloaded, or put away by the browser): a draft deleted in the last 10 seconds goes now
  const gone = () => { if (!live || stale) return; leaving = true; commitDeletes(true); flush(); leaving = false; };
  window.addEventListener('pagehide', gone);
  document.addEventListener('freeze', gone);

  /* ---------- plants ----------
     Each change on the Plants page goes to the Sheet at once (savePlant, deletePlant, approveAdoption, declineAdoption),
     and the page takes the plants as the Sheet answers with them. basePlants: the Sheet's plants as last read, so a read
     that finds them changed (by hand in the Sheet, or from another tab) shows it; plantsAt: when the last change came back. */
  let basePlants = '', plantsAt = 0;
  // a plant tag's QR code: this page's own address, as for events (on Netlify, https://ebpg-event-hub.netlify.app/?plant=001)
  plantLink = id => G.url ? G.url + '?plant=' + encodeURIComponent(id) : '';
  plantCall = async (fn, arg) => {
    if (stale) throw new Error(STALE);
    if (!live) throw new Error('Sign in again to change the plants.');
    const g = gen;
    let out;
    try { out = await run(fn, code, arg); }
    catch (er) {
      if (codeGone(er)) { staleCode(); throw new Error(STALE); }
      if (!er.net) setTimeout(() => refresh(true), 0); // the Sheet said no (another organizer got there first, say): show what it has now
      throw er.net ? new Error("The Guild Sheet didn't answer. Try again in a minute.") : er;
    } finally { plantsAt = Date.now(); }
    if (g !== gen) throw new Error('You signed out before the Guild Sheet answered.');
    if (out && Array.isArray(out.plants)) basePlants = JSON.stringify(out.plants);
    return out;
  };

  /* ---------- test mode ----------
     While TEST_MODE is on, every page an organizer sees says where the emails go, with a link to the Sheet. */
  let testHTML = ''; // what the banner was last given (the browser writes <use/> back as <use></use>, so not bar.innerHTML)
  function testBar(st) {
    const bar = $('#testbar'), on = !!(st && st.testMode);
    testOn = on; // a test send offers Post for real only once test mode is off
    bar.hidden = !on;
    if (!on) { bar.innerHTML = testHTML = ''; return; }
    const link = safeUrl(st.sheetUrl);
    const html = `${ic('mail')}<span class="grow"><b>Test mode:</b> every email goes only to ${esc(st.owner || 'the Sheet owner')}. Turn it off on the Settings tab when you're ready to go live.</span>`
      + (link ? `<a class="btn ghost sm" href="${esc(link)}" target="_blank" rel="noopener">Open the Sheet${ic('out')}</a>` : '');
    if (html !== testHTML) bar.innerHTML = testHTML = html; // redrawn only when it changes, so a focused link keeps focus
  }

  /* ---------- signing in and out ---------- */
  // while a sign-in is going: who it's for, and the line under the name picker (pickLine: the line once it's done)
  let signing = false, signingAs = '', waitLine = '', pickLine = '';
  const WAKING = 'Waking up the Guild Sheet. This can take a few seconds.';
  /* Continue, on a Sheet with no names to show (nobody has set it up yet, or its public data didn't arrive): the
     Sheet's answer to the code, kept until a name is picked, so picking one finishes signing in without asking again. */
  let held = null;
  // the name picker shows the sign-in that's going: that name says "Signing in…", the others wait.
  // Run again after the picker is redrawn (the Sheet's team can arrive mid sign-in), so it isn't lost.
  function showSigning() {
    $$('#si-pick button').forEach(b => {
      const me = signing && b.dataset.as === signingAs, small = b.querySelector('small');
      if (small && small.dataset.role === undefined) small.dataset.role = small.textContent;
      b.disabled = signing && !me;
      if (me) { b.setAttribute('aria-busy', 'true'); b.setAttribute('aria-disabled', 'true'); }
      else { b.removeAttribute('aria-busy'); b.removeAttribute('aria-disabled'); }
      if (small) small.textContent = me ? 'Signing in…' : small.dataset.role;
    });
    $('#si-wait').textContent = signing ? waitLine : pickLine;
  }
  // Continue worked: the code is right (and an empty Sheet is now filled). The names to pick come from the Sheet's answer.
  function hold(c, st, info) {
    const team = namesOnly(st.team);
    if (!team.some(t => t.role !== 'vol')) throw new Error('Nobody is on the Team tab as an organizer yet. Add yourself there with the role lead or co, then try again.');
    held = { c, st, info };
    TEAM.splice(0, TEAM.length, ...team);
    signing = false; signingAs = ''; pickLine = 'The Guild Sheet is ready. Pick your name.';
    redrawLanding();
    $('#si-pick button[data-as]')?.focus();
  }
  // redraw the landing page without losing a sign-in that's going, or the name that has keyboard focus
  function redrawLanding() {
    const f = document.activeElement?.closest?.('#si-pick [data-as]')?.dataset.as;
    renderLanding(); showSigning();
    if (f) $$('#si-pick [data-as]').find(b => b.dataset.as === f)?.focus();
  }
  remote = {
    // resume: signing back in with the stored code after a reload
    async signIn(name, resume) {
      if (signing) return;
      const typed = $('#si-code').value.trim(), err = $('#si-err');
      const c = typed || (stale ? '' : code); // the code this page had was turned down, so only a typed one
      if (!c) { err.textContent = 'Type the organizer code first.'; err.hidden = false; $('#si-code').focus(); return; }
      err.hidden = true;
      // a name picked after Continue: the Sheet has already answered for this code
      const h = held && name && held.c === c ? held : null;
      held = null; pickLine = '';
      signing = true; signingAs = name; waitLine = WAKING;
      showSigning();
      try {
        let st, info;
        if (h) ({ st, info } = h);
        else {
          st = info = await run('signIn', c); // info: seed's answer has no test-mode details
          sheetUrl = st.sheetUrl || '';
          if (live && stale && !st.empty) {
            // the same session with the new code: keep the changes made here, take the rest from the Sheet, and save now
            code = c; stale = false; tries = 0; failShown = false;
            testBar(st); merge(st, Date.now());
            store.keep(c, name, resume ? undefined : $('#si-rem').checked);
            $('#si-err').hidden = true;
            if (!person(name) || person(name).role === 'vol') name = (organizers()[0] || TEAM[0]).name;
            finishSignIn(name);
            retryNow(true);
            return;
          }
          if (st.empty) {
            waitLine = 'Setting up the Guild Sheet for the first time. This can take up to a minute.';
            showSigning();
            st = await run('seed', c, SEED);
          }
          if (!name) return hold(c, st, info); // Continue: now pick a name from the Sheet's team
        }
        if (!(st.team || []).length) throw new Error('Nobody is on the Team tab yet. Add yourself there with the role lead, then sign in again.');
        code = c; reset(); load(st); live = true; testBar(info);
        renderVols(); renderMaterials(); renderLanding();
        if (!person(name) || person(name).role === 'vol') name = (organizers()[0] || TEAM[0]).name;
        store.keep(c, name, resume ? undefined : $('#si-rem').checked);
        finishSignIn(name); // opens the plan of the event this page was opened at (planAfter), if any
      } catch (er) {
        // a wrong code is forgotten; when the Sheet just didn't answer, or sign-in is paused after too many
        // wrong codes (someone else's), the stored code is kept for another try
        if (!er.net && !/^Too many tries/.test(er.message)) { store.clear(); code = ''; }
        err.textContent = er.net ? `The Guild Sheet didn't answer. Check your internet, then ${name ? 'pick your name' : 'press Continue'} to try again.` : er.message;
        err.hidden = false;
        if (!$('#p-signin').hidden || !typed) goSignIn();
      } finally {
        signing = false; signingAs = '';
        showSigning();
      }
    },
    /* Post (the Google Group or the Calendar): the Sheet saves the event as this page has it, sends it, and
       answers with the event's Posts rows and Activity as they now are, which replace this page's.
       opts.force: post again (Update calendar, Post for real). opts.text: the text to send, when it's new. */
    post: async (ev, ch, opts = {}) => {
      if (stale) throw new Error(STALE);
      const k = keyOf(ev), pl = payload(ev), sent = JSON.stringify(pl), n0 = (ev.log || []).length;
      const mineP = pl.posts.find(x => x.channel === ch);
      if (mineP && opts.text != null) mineP.text = opts.text;
      pl.created = !!ev.created; // never saved yet: postTo saves it first, as a new row
      touched[k] = Date.now(); // a read of the Sheet that started before this is older than what's coming
      const g = gen;
      let out;
      try { out = await run('postTo', code, pl, ch, { by: ME, force: !!opts.force }); }
      catch (er) {
        if (codeGone(er)) { staleCode(); throw new Error(STALE); }
        if (removed(er)) throw new Error(dropRemoved(k));
        throw er.net ? new Error("The Guild Sheet didn't answer, so we can't tell if it went out. Check the Sheet before posting again.") : er;
      } finally { touched[k] = Date.now(); }
      const cur = EVENTS.find(e => e.id === ev.id) || ev, fresh = out && out.event && fromRows(out.event);
      if (fresh && g === gen) delete cur.created; // the Sheet has its row now
      if (fresh && g === gen) { // not when signed out meanwhile
        // nothing else changed while it went out: the Sheet now has exactly this event, so there's nothing left to save
        const same = !busy(k) && snapEv(cur) === sent;
        CHANNELS.forEach(c => {
          const s = fresh.posts[c.id], was = cur.posts[c.id];
          // this channel, and any Group email or Calendar entry the Sheet says went out that this page didn't know of
          if (c.id === ch || (c.mode === 'auto' && isSent(s) && !isSent(was))) cur.posts[c.id] = s;
        });
        cur.log = fresh.log.concat((cur.log || []).slice(n0)); // lines added here while it went out stay
        if (same) { saved[k] = snapEv(cur); mine.add(k); }
      }
      return (out && out.message) || 'Posted.';
    },
    /* Cancel event: this page's changes to it reach the Sheet first, then the Sheet cancels it (cancelEvent) and answers
       with its Posts rows and Activity as they now are: the notices to approve, and who cancelled it. Resolves with what
       the Sheet said happened. */
    cancel: async (ev, reason) => {
      if (stale) throw new Error(STALE);
      const k = keyOf(ev);
      flush(); await settled(k);
      if (stale) throw new Error(STALE);
      if (ev.created) throw new Error("This event hasn't reached the Guild Sheet yet. Try again once the chip says All changes saved.");
      const before = snapEv(ev), n0 = (ev.log || []).length, g = gen;
      touched[k] = Date.now();
      let out;
      try { out = await run('cancelEvent', code, ev.id, reason, ME); }
      catch (er) {
        if (codeGone(er)) { staleCode(); throw new Error(STALE); }
        if (removed(er)) throw new Error(dropRemoved(k));
        throw er.net ? new Error("The Guild Sheet didn't answer, so we can't tell if it was cancelled. Check the Sheet before trying again.") : er;
      } finally { touched[k] = Date.now(); }
      const cur = EVENTS.find(e => e.id === ev.id), fresh = out && out.event && fromRows(out.event);
      if (cur && fresh && g === gen) {
        // nothing changed here while it went: the Sheet now has exactly this, so there's nothing left to save
        const same = !busy(k) && saved[k] === before && snapEv(cur) === before;
        cur.status = 'cancelled';
        CHANNELS.forEach(c => { cur.posts[c.id] = fresh.posts[c.id]; });
        cur.log = fresh.log.concat((cur.log || []).slice(n0));
        if (same) { saved[k] = snapEv(cur); mine.add(k); }
      }
      return (out && out.message) || 'Cancelled.';
    },
    /* Delete draft, once its 10 seconds to undo are over: a save of it already on its way lands first, so the Sheet's
       tombstone is the last word. now: the page is closing, so the call goes out at once. */
    del: (ev, now) => {
      const k = keyOf(ev), c = code;
      const go = () => run('deleteEvent', c, ev.id).then(() => { forget(k); }, er => {
        if (codeGone(er)) { staleCode(); throw new Error(STALE); }
        throw er.net ? new Error("The Guild Sheet didn't answer, so it's still there. Try again in a minute.") : er;
      });
      if (stale) return Promise.reject(new Error(STALE));
      return now || !busy(k) ? go() : settled(k).then(go);
    },
    /* the volunteer form: resolves once the Sheet has the sign-up. A failure is thrown for the form to show: with Try
       again when the Sheet wasn't reached (net: true), or the Sheet's own words. */
    join: async v => {
      let out;
      try { out = await run('addVolunteer', { ...v, help: v.help.map(k => Object.fromEntries(HELP)[k] || k) }); }
      catch (er) {
        if (!er.net) throw er; // the Sheet's own words, e.g. "That email address doesn't look right."
        throw Object.assign(new Error("We couldn't reach the Guild Sheet, so your sign-up didn't go through. Your answers are still here."), { net: true });
      }
      // an organizer signed in here: the Volunteer list reads the Sheet again, which has the row as it was kept
      // (a new row, or someone's own row with these answers added), and that's no news to toast about
      if (live && !stale) { mine.add('vols'); setTimeout(() => refresh(true), 0); }
      return out;
    },
  };
  // signing out with changes the Sheet doesn't have yet asks first
  leaveOk = () => {
    if (!live) return true;
    commitDeletes(true); // a draft deleted in the last 10 seconds goes before signing out
    flush();
    if (failedKeys().length && !confirm("Some changes haven't reached the Guild Sheet yet. Sign out anyway and lose them?")) return false;
    live = false; code = ''; sheetUrl = ''; problems = []; store.clear(); reset(); testBar(null); applyChannels([]);
    PLANTS.length = 0; basePlants = ''; // the plants have contacts: they go with the code
    $('#si-rem').checked = false; // this device is forgotten, so the box starts unticked for whoever signs in next
    return true;
  };

  // live-only page tweaks
  const rs = history.replaceState.bind(history);
  history.replaceState = (...a) => { try { rs(...a); } catch {} }; // the Apps Script frame may refuse URL changes
  $('#si-code').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#si-pick button')?.focus(); } });

  const boot = () => {
    loadPublic(cached()); // last visit's public data, shown at once; the Sheet's answer replaces it below
    renderAs(); render(); renderMaterials(); renderTeam(); renderLanding(); bindJoin(); renderVols();
    const user = AUTH.get() || store.kept().name;
    // a remembered device stays remembered when signing back in fails and someone picks their name again
    if (store.kept().code) $('#si-rem').checked = true;
    document.body.classList.add('out');
    // an event link (?ev=): organizers signing back in get its plan; everyone else its public page, with grey shapes
    // until the Sheet answers (unless the last visit's answer has it)
    planAfter = G.ev;
    if (user && code) { showTab('resume'); remote.signIn(user, true); } // not the landing page: we're signing straight back in
    else if (G.ev) showPubEvent(G.ev);
    else showTab('landing');
  };
  /* The public data: published events, the organizers' names, gardens and a few settings. Until it arrives (Apps
     Script can take a few seconds to wake up) the page shows grey shapes, or what the last visit got. If it never
     does, the page says so and points to the Linktree, and tries again when the tab comes back or the connection does. */
  let readingPublic = false;
  const publicFailed = () => {
    if (live || held) return; // signed in meanwhile, or Continue already has the Sheet's answer
    pubState = 'failed'; redrawLanding(); // last visit's events stay on show, if there were any
  };
  function readPublic() {
    if (readingPublic || live) return;
    readingPublic = true;
    run('getPublic').then(st => {
      if (!st || !Array.isArray(st.events)) return publicFailed();
      keepPublic(st); pubAnswered = true;
      if (live || held) { pubSettings(st.settings); renderMaterials(); return; } // the Sheet's own rows win; its public Settings still count
      loadPublic(st); render(); renderMaterials(); redrawLanding();
    }, publicFailed).finally(() => { readingPublic = false; });
  }
  window.addEventListener('online', () => { if (pubState === 'failed') readPublic(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pubState === 'failed') readPublic(); });
  boot();
  readPublic();
}
