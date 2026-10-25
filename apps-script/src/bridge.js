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
    const { tasks, log, posts, isNew, ...data } = ev, pl = ev.plan;
    return {
      id: ev.id, data,
      cols: { label: ev.label || '', title: ev.title, date: ev.date, start: ev.start, end: ev.end, place: ev.place, address: ev.address || '', host: hostOf(pl), cohosts: cohostsOf(pl).join(', '),
        about: ev.about || '', bring: ev.bring || '', tags: ev.tags.join(', '), notes: (pl.notes || []).join('\n'), timeline: PT.timeline(pl) },
      tasks: (tasks || []).map(t => ({ id: t.id, what: t.text, who: t.who || '', status: t.status || '', last: t.last || '' })),
      posts: CHANNELS.filter(c => posts[c.id] && posts[c.id].status !== 'off').map(c => ({ channel: c.id, status: posts[c.id].status, by: posts[c.id].by || '', text: posts[c.id].text, edited: !!posts[c.id].edited })),
      log: log || [],
    };
  };
  const ID_OK = /^[A-Za-z0-9_-]{1,40}$/; // the ids the Sheet accepts (ID_RE in Code.js)
  const BLANK_PLAN = () => ({ leadStart: '', leadEnd: '', leadNote: '', roles: [], pending: [], setup: [], supplies: [], food: null, timeline: [], icebreaker: '', questions: [], notes: [], areas: [], debrief: [] });
  function fromRows(r) {
    const c = r.cols, ev = Object.assign({ tags: [], photo: 'trellis' }, r.data);
    ev.plan = Object.assign(BLANK_PLAN(), ev.plan || {});
    const pl = ev.plan;
    Object.assign(ev, { id: c.id, label: c.label, title: c.title, date: c.date, start: c.start, end: c.end, place: c.place, address: c.address, about: c.about, bring: c.bring });
    if (split(c.tags).join(',') !== ev.tags.join(',')) ev.tags = split(c.tags);
    // hand edits in the Sheet win; untouched cells keep the richer saved plan
    if (c.host !== hostOf(pl) || c.cohosts !== cohostsOf(pl).join(', ')) pl.roles = [['Host', c.host ? [c.host] : []], ['Co-hosts', split(c.cohosts).filter(n => n !== c.host)]];
    if (c.notes !== (pl.notes || []).join('\n')) pl.notes = lns(c.notes);
    if (c.timeline !== PT.timeline(pl)) pl.timeline = parseTimeline(c.timeline);
    ev.host = hostOf(pl) || ev.host || '';
    // a task id typed by hand that the Sheet wouldn't take back gets a new one
    ev.tasks = r.tasks.map(t => Object.assign(mkTask('other', t.what, t.who, t.status || (t.who ? 'asked' : 'open')), ID_OK.test(t.id || '') ? { id: t.id } : {}, t.last ? { last: t.last } : {}));
    ev.posts = {};
    CHANNELS.forEach(ch => {
      const p = r.posts[ch.id];
      ev.posts[ch.id] = p ? { status: STATUS[p.status] ? p.status : 'review', text: p.text || draft(ch.id, ev), edited: !!p.edited, by: p.by || '', open: false }
        : { status: 'off', text: draft(ch.id, ev), edited: false, by: '', open: false };
    });
    ev.log = r.log;
    return ev;
  }
  const snapEv = ev => JSON.stringify(payload(ev));
  const snapTeam = () => JSON.stringify(TEAM.map(({ name, role, contact, via, perms }) => ({ name, role, contact, via, perms })));
  const vols = list => list.map(v => ({ ...v, help: v.help.map(l => (HELP.find(h => h[1].toLowerCase() === l.toLowerCase()) || [l])[0]) }));

  /* ---------- saving ----------
     Each event, and the team, is a save "key". saved[key] is what the Sheet has as far as this page knows,
     base[key] the Sheet's own rows as last read. One save per key is out at a time; when it comes back,
     only the newest version goes next. A failed save is retried after 2 s, 5 s, 15 s, then every 60 s. */
  const saved = {}, base = {}, touched = {};
  let Q = {}, mine = new Set(), waits = [], gen = 0, timer = 0, retryTimer = 0, tries = 0, manual = false, failShown = false;
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
    q.busy = true; touched[k] = Date.now();
    const g = gen;
    run(k === 'team' ? 'saveTeam' : 'saveEvent', code, JSON.parse(s))
      .then(() => { if (g !== gen) return; saved[k] = s; q.failed = false; q.err = null; mine.add(k); },
        er => { if (g !== gen) return; q.failed = true; q.err = er; })
      .then(() => {
        if (g !== gen) return;
        q.busy = false; touched[k] = Date.now();
        if (q.failed) { retryLater(); noteFailure(q.err); }
        else if (!timer && dirty(k)) send(k); // changes made while it was out
        status();
      });
  }
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
  const CHIP = { saving: ['loader', 'Saving…'], saved: ['check', 'All changes saved'], failed: ['alert-triangle', 'Not saved'] };
  let chipState = 'idle', fadeT = 0, failedIds = '';
  function chip(st) {
    if (st === chipState) return;
    clearTimeout(fadeT);
    chipState = st;
    $$('.savest').forEach(el => {
      const btn = el.querySelector('button'), hadFocus = document.activeElement === btn;
      el.classList.remove('fade'); el.dataset.state = st;
      el.firstElementChild.innerHTML = CHIP[st] ? ic(CHIP[st][0]) + esc(CHIP[st][1]) : '';
      btn.hidden = st !== 'failed';
      if (hadFocus && btn.hidden) el.focus(); // keep keyboard focus nearby while it retries
    });
    if (st === 'saved') fadeT = setTimeout(() => { $$('.savest').forEach(el => el.classList.add('fade')); fadeT = setTimeout(() => chip('idle'), 650); }, 3000);
  }
  function status() {
    const ks = keys(), out = ks.some(busy), bad = failedKeys();
    if (!out) manual = false;
    let st;
    if (!live) st = 'idle';
    else if (bad.length && !manual) st = 'failed';
    else if (out || ks.some(dirty)) st = 'saving';
    else st = chipState === 'idle' ? 'idle' : 'saved';
    if (st === 'failed') waits = [];
    if (st === 'idle' || st === 'saved') {
      failShown = false; tries = 0; clearTimeout(retryTimer); retryTimer = 0;
      const w = waits; waits = []; w.forEach(f => f());
    }
    chip(st);
    const ids = bad.filter(k => k !== 'team').sort().join(',');
    if (ids !== failedIds) { failedIds = ids; markUnsaved(); }
  }
  $$('.savest button').forEach(b => b.addEventListener('click', () => retryNow(true)));
  window.addEventListener('online', () => { if (live && failedKeys().length) retryNow(false); });
  // closing the tab: send what's left; if anything still isn't saved, the browser asks first
  window.addEventListener('beforeunload', e => {
    if (!live) return;
    leaving = true; flush(); leaving = false;
    if (keys().some(k => busy(k) || dirty(k)) || failedKeys().length) { e.preventDefault(); e.returnValue = 'Some changes are not saved yet.'; }
  });

  /* ---------- reading the Sheet ---------- */
  // the first sign-in fills an empty Sheet with this: the Guild's real plans, the team with contacts still blank, and no volunteers
  const SEED = { events: EVENTS.map(payload), team: JSON.parse(JSON.stringify(TEAM)), vols: [], gardens: GARDENS.slice() };
  function load(st) {
    if (st.events.length) { EVENTS.length = 0; st.events.forEach(r => EVENTS.push(fromRows(r))); }
    if (st.team?.length) TEAM.splice(0, TEAM.length, ...st.team);
    if (st.vols) VOLS.splice(0, VOLS.length, ...vols(st.vols));
    if (st.gardens?.length) GARDENS.splice(0, GARDENS.length, ...st.gardens);
    problems = st.problems || []; // only signIn and seed send these, so the public page never has any
    taskSeq = Math.max(taskSeq, ...EVENTS.flatMap(e => e.tasks.map(t => +String(t.id).replace(/\D/g, '') || 0)));
    EVENTS.forEach(e => { saved[keyOf(e)] = snapEv(e); });
    saved.team = snapTeam();
    st.events.forEach(r => { base['e:' + r.cols.id] = JSON.stringify(r); });
    base.team = JSON.stringify(st.team || []); base.vols = JSON.stringify(st.vols || []);
    if (!EVENTS.find(e => e.id === S.sel)) S.sel = nextEvent()?.id;
  }
  // start over: a new sign-in, or signing out
  function reset() {
    gen++; Q = {}; mine = new Set(); waits = []; tries = 0; manual = false; failShown = false;
    clearTimeout(timer); clearTimeout(retryTimer); timer = retryTimer = 0;
    [saved, base, touched].forEach(o => Object.keys(o).forEach(k => delete o[k]));
    chip('idle'); failedIds = '';
  }

  /* Coming back to the tab, and every 2 minutes while it's open, read the Sheet again. Events and the team
     take what's there unless they have changes of their own here, or are being edited. */
  let reading = false, lastRead = 0;
  async function refresh(force) {
    if (!live || reading || document.hidden) return;
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
    } catch {} finally { reading = false; }
  }
  function merge(st, t0) {
    const open = $('#detail') ? S.sel : null;
    const typing = () => { const a = document.activeElement; return !!(a && a.closest && a.closest('#detail') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
    // a save that started or ended after this read began may be newer than what the read saw
    const held = k => dirty(k) || busy(k) || !!(Q[k] && Q[k].failed) || touched[k] >= t0;
    const editing = ev => ev.id === open && (S.editing || typing());
    let news = false, evs = false, openRedo = false, team = false, vl = false;
    const seen = new Set();
    st.events.forEach(r => {
      const id = r.cols.id, k = 'e:' + id, raw = JSON.stringify(r);
      seen.add(id);
      if (base[k] === raw) return;
      const i = EVENTS.findIndex(e => e.id === id), cur = EVENTS[i];
      if (cur && (cur.isNew || held(k) || editing(cur))) return;
      const fresh = fromRows(r), s = snapEv(fresh), ours = mine.delete(k);
      base[k] = raw; saved[k] = s;
      if (cur && s === snapEv(cur)) return; // the Sheet has what this page shows
      if (cur) { CHANNELS.forEach(c => { if (cur.posts[c.id]?.open && fresh.posts[c.id]) fresh.posts[c.id].open = true; }); EVENTS[i] = fresh; }
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
    if (st.team?.length && rawTeam !== base.team && !held('team')) {
      const before = snapTeam(), ours = mine.delete('team');
      TEAM.splice(0, TEAM.length, ...st.team);
      base.team = rawTeam; saved.team = snapTeam();
      if (saved.team !== before) { team = true; if (!ours) news = true; }
    }
    const rawVols = JSON.stringify(st.vols || []);
    if (st.vols && rawVols !== base.vols) { base.vols = rawVols; VOLS.splice(0, VOLS.length, ...vols(st.vols)); vl = news = true; }
    problems = st.problems || [];
    renderProblems();
    if (evs) {
      taskSeq = Math.max(taskSeq, ...EVENTS.flatMap(e => e.tasks.map(t => +String(t.id).replace(/\D/g, '') || 0)));
      const ft = document.activeElement?.closest?.('#tiles [data-open]')?.dataset.open;
      renderAttn(); renderTiles(); renderMaterials(); redrawLanding();
      if (ft) $$('#tiles [data-open]').find(t => t.dataset.open === ft)?.focus();
      if (openRedo) renderDetail();
    }
    if (team) { renderAs(); renderTeam(); }
    if (vl) renderVols();
    status();
    return news;
  }
  setInterval(() => refresh(true), 120000);
  document.addEventListener('visibilitychange', () => {
    if (!live) return;
    if (document.hidden) { leaving = true; flush(); leaving = false; } // a phone may close the page without warning
    else { if (failedKeys().length) retryNow(false); refresh(); } // back on the tab: try failed saves again now
  });

  /* ---------- test mode ----------
     While TEST_MODE is on, every page an organizer sees says where the emails go, with a link to the Sheet. */
  function testBar(st) {
    const bar = $('#testbar'), on = !!(st && st.testMode);
    bar.hidden = !on;
    if (!on) { bar.innerHTML = ''; return; }
    const link = safeUrl(st.sheetUrl);
    const html = `${ic('mail')}<span class="grow"><b>Test mode:</b> every email goes only to ${esc(st.owner || 'the Sheet owner')}. Turn it off on the Settings tab when you're ready to go live.</span>`
      + (link ? `<a class="btn ghost sm" href="${esc(link)}" target="_blank" rel="noopener">Open the Sheet${ic('out')}</a>` : '');
    if (bar.innerHTML !== html) bar.innerHTML = html; // redrawn only when it changes, so a focused link keeps focus
  }

  /* ---------- signing in and out ---------- */
  // while a sign-in is going: who it's for, and the line under the name picker
  let signing = false, signingAs = '', waitLine = '';
  const WAKING = 'Waking up the Guild Sheet. This can take a few seconds.';
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
    $('#si-wait').textContent = signing ? waitLine : '';
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
      const c = typed || code;
      if (!c) { err.textContent = 'Type the organizer code first.'; err.hidden = false; $('#si-code').focus(); return; }
      err.hidden = true;
      signing = true; signingAs = name; waitLine = WAKING;
      showSigning();
      try {
        let st = await run('signIn', c);
        sheetUrl = st.sheetUrl || '';
        const info = st; // seed's answer has no test-mode details
        if (st.empty) {
          waitLine = 'Setting up the Guild Sheet for the first time. This can take up to a minute.';
          showSigning();
          st = await run('seed', c, SEED);
        }
        code = c; reset(); load(st); live = true; testBar(info);
        renderVols(); renderMaterials(); renderLanding();
        if (!person(name) || person(name).role === 'vol') name = (organizers()[0] || TEAM[0]).name;
        store.keep(c, name, resume ? undefined : $('#si-rem').checked);
        finishSignIn(name);
        if (G.ev && EVENTS.find(e => e.id === G.ev)) openEvent(G.ev, 'page');
        G.ev = '';
      } catch (er) {
        // a wrong code is forgotten; when the Sheet just didn't answer, or sign-in is paused after too many
        // wrong codes (someone else's), the stored code is kept for another try
        if (!er.net && !/^Too many tries/.test(er.message)) { store.clear(); code = ''; }
        err.textContent = er.net ? "The Guild Sheet didn't answer. Check your internet, then pick your name to try again." : er.message;
        err.hidden = false;
        if (!$('#p-signin').hidden || !typed) goSignIn();
      } finally {
        signing = false; signingAs = '';
        showSigning();
      }
    },
    // post after the event's own save is in, so the Sheet has what's being posted
    post: async (ev, ch) => {
      await settle(keyOf(ev));
      try { return await run('postTo', code, ev.id, ch, ev.posts[ch].text); }
      catch (er) { throw er.net ? new Error("The Guild Sheet didn't answer, so we can't tell if it went out. Check before posting again.") : er; }
    },
    join: v => run('addVolunteer', { ...v, help: v.help.map(k => Object.fromEntries(HELP)[k] || k) })
      .catch(er => toast(er.net ? "Couldn't send your sign-up. The Guild Sheet didn't answer, so please try again in a minute." : "Couldn't send your sign-up: " + er.message)),
  };
  // wait until this key's save is in (or say why it isn't)
  function settle(k) {
    flush();
    const g = gen, until = Date.now() + 35000;
    return new Promise((ok, no) => {
      const check = () => {
        const q = Q[k];
        if (g !== gen) return no(new Error('You signed out.'));
        if (q && q.failed && !q.busy) return no(new Error("This event isn't saved yet, so it can't be posted. Try again in a moment."));
        if (!busy(k) && !dirty(k)) return ok();
        if (Date.now() > until) return no(new Error("This event isn't saved yet, so it can't be posted. Try again in a moment."));
        setTimeout(check, 150);
      };
      check();
    });
  }
  // signing out with changes the Sheet doesn't have yet asks first
  leaveOk = () => {
    if (!live) return true;
    flush();
    if (failedKeys().length && !confirm("Some changes haven't reached the Guild Sheet yet. Sign out anyway and lose them?")) return false;
    live = false; code = ''; sheetUrl = ''; problems = []; store.clear(); reset(); testBar(null);
    $('#si-rem').checked = false; // this device is forgotten, so the box starts unticked for whoever signs in next
    return true;
  };

  // live-only page tweaks
  const rs = history.replaceState.bind(history);
  history.replaceState = (...a) => { try { rs(...a); } catch {} }; // the Apps Script frame may refuse URL changes
  evLink = id => G.url ? G.url + '?ev=' + encodeURIComponent(id) : '';
  CH.luma.mode = 'copy'; CH.luma.note = '';
  $('#si-code').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#si-pick button')?.focus(); } });

  const boot = () => {
    renderAs(); render(); renderMaterials(); renderTeam(); renderLanding(); bindJoin(); renderVols();
    const user = AUTH.get() || store.kept().name;
    // a remembered device stays remembered when signing back in fails and someone picks their name again
    if (store.kept().code) $('#si-rem').checked = true;
    document.body.classList.add('out');
    if (user && code) { showTab('resume'); remote.signIn(user, true); } // not the landing page: we're signing straight back in
    else showTab(G.ev ? 'signin' : 'landing');
  };
  // show the page right away, then swap in what's in the Sheet (Apps Script can take a few seconds to wake up)
  boot();
  run('getPublic').then(st => { if (live) return; load(st); render(); renderMaterials(); redrawLanding(); })
    .catch(er => toast(er.net ? "Couldn't reach the Guild Sheet. Refresh the page to try again." : "Couldn't reach the Sheet: " + er.message));
}
