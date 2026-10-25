/* live mode: the page talks to the Google Sheet through Apps Script */
if (window.EBPG_GAS) {
  const G = window.EBPG_GAS;
  // On Netlify the page calls the Apps Script web app's JSON API; inside Google it uses google.script.run.
  // text/plain keeps the request "simple", so the browser sends it without a CORS preflight.
  const run = (fn, ...a) => G.api
    ? (body => fetch(G.api, { method: 'POST', body, keepalive: body.length < 60000 }))(JSON.stringify({ fn, args: a }))
      .then(r => r.json(), () => { throw new Error('No connection to the Guild Sheet. Check your internet and try again.'); })
      .then(r => { if (r.error) throw new Error(r.error); return r.value; })
    : new Promise((ok, no) => google.script.run
      .withSuccessHandler(ok)
      .withFailureHandler(e => no(new Error(String((e && e.message) || e).replace(/^Exception:\s*/, ''))))[fn](...a));
  const store = { get: k => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch {} } };
  let code = store.get('ebpg-code'), live = false, timer;
  const saved = {};
  let savedTeam = '';

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
    ev.tasks = r.tasks.map(t => Object.assign(mkTask('other', t.what, t.who, t.status || (t.who ? 'asked' : 'open')), t.id ? { id: t.id } : {}, t.last ? { last: t.last } : {}));
    ev.posts = {};
    CHANNELS.forEach(ch => {
      const p = r.posts[ch.id];
      ev.posts[ch.id] = p ? { status: p.status || 'review', text: p.text || draft(ch.id, ev), edited: !!p.edited, by: p.by || '', open: false }
        : { status: 'off', text: draft(ch.id, ev), edited: false, by: '', open: false };
    });
    ev.log = r.log;
    return ev;
  }
  const snapEv = ev => JSON.stringify(payload(ev));
  const snapTeam = () => JSON.stringify(TEAM.map(({ name, role, contact, via, perms }) => ({ name, role, contact, via, perms })));
  function load(st) {
    if (st.events.length) { EVENTS.length = 0; st.events.forEach(r => EVENTS.push(fromRows(r))); }
    if (st.team?.length) TEAM.splice(0, TEAM.length, ...st.team);
    if (st.vols) VOLS.splice(0, VOLS.length, ...st.vols.map(v => ({ ...v, help: v.help.map(l => (HELP.find(h => h[1].toLowerCase() === l.toLowerCase()) || [l])[0]) })));
    if (st.gardens?.length) GARDENS.splice(0, GARDENS.length, ...st.gardens);
    problems = st.problems || []; // only signIn and seed send these, so the public page never has any
    taskSeq = Math.max(taskSeq, ...EVENTS.flatMap(e => e.tasks.map(t => +String(t.id).replace(/\D/g, '') || 0)));
    EVENTS.forEach(e => { saved[e.id] = snapEv(e); });
    savedTeam = snapTeam();
    if (!EVENTS.find(e => e.id === S.sel)) S.sel = nextEvent()?.id;
  }
  // the first sign-in fills an empty Sheet with this: the Guild's real plans, the team with contacts still blank, and no volunteers
  const SEED = { events: EVENTS.map(payload), team: JSON.parse(JSON.stringify(TEAM)), vols: [], gardens: GARDENS.slice() };

  // save whatever changed, a moment after it changed
  sync = () => { if (!live) return; clearTimeout(timer); timer = setTimeout(flush, 800); };
  function flush() {
    EVENTS.filter(e => !e.isNew).forEach(ev => {
      const s = snapEv(ev);
      if (saved[ev.id] === s) return;
      const before = saved[ev.id]; saved[ev.id] = s;
      run('saveEvent', code, JSON.parse(s)).catch(er => { if (saved[ev.id] === s) saved[ev.id] = before; toast("Couldn't save: " + er.message); });
    });
    const t = snapTeam();
    if (t !== savedTeam) { const before = savedTeam; savedTeam = t; run('saveTeam', code, JSON.parse(t)).catch(er => { savedTeam = before; toast("Couldn't save the team: " + er.message); }); }
  }
  window.addEventListener('beforeunload', e => { if (live) { clearTimeout(timer); flush(); } });

  remote = {
    async signIn(name) {
      const typed = $('#si-code').value.trim(), err = $('#si-err');
      const c = typed || code;
      if (!c) { err.textContent = 'Type the organizer code first.'; err.hidden = false; $('#si-code').focus(); return; }
      err.hidden = true;
      $$('#si-pick button').forEach(b => b.disabled = true);
      try {
        let st = await run('signIn', c);
        sheetUrl = st.sheetUrl || '';
        if (st.empty) st = await run('seed', c, SEED);
        code = c; store.set('ebpg-code', c); load(st); live = true;
        renderVols(); renderMaterials(); renderLanding();
        if (!person(name) || person(name).role === 'vol') name = (organizers()[0] || TEAM[0]).name;
        finishSignIn(name);
        if (G.ev && EVENTS.find(e => e.id === G.ev)) openEvent(G.ev, 'page');
        G.ev = '';
      } catch (er) {
        store.set('ebpg-code', ''); code = '';
        err.textContent = er.message; err.hidden = false;
        if (!$('#p-signin').hidden || !typed) goSignIn();
      } finally { $$('#si-pick button').forEach(b => b.disabled = false); }
    },
    post: (ev, ch) => { clearTimeout(timer); flush(); return run('postTo', code, ev.id, ch, ev.posts[ch].text); },
    join: v => run('addVolunteer', { ...v, help: v.help.map(k => Object.fromEntries(HELP)[k] || k) }).catch(er => toast("Couldn't send your sign-up: " + er.message)),
  };
  $('#signout').addEventListener('click', () => { if (live) flush(); live = false; code = ''; sheetUrl = ''; problems = []; store.set('ebpg-code', ''); }, true);

  // live-only page tweaks
  const rs = history.replaceState.bind(history);
  history.replaceState = (...a) => { try { rs(...a); } catch {} }; // the Apps Script frame may refuse URL changes
  evLink = id => G.url ? G.url + '?ev=' + encodeURIComponent(id) : '';
  CH.luma.mode = 'copy'; CH.luma.note = '';
  $('#si-code').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#si-pick button')?.focus(); } });

  const boot = () => {
    renderAs(); render(); renderMaterials(); renderTeam(); renderLanding(); bindJoin(); renderVols();
    const user = AUTH.get();
    if (user && code) { document.body.classList.add('out'); showTab('landing'); remote.signIn(user); }
    else { document.body.classList.add('out'); showTab(G.ev ? 'signin' : 'landing'); }
  };
  // show the page right away, then swap in what's in the Sheet (Apps Script can take a few seconds to wake up)
  boot();
  run('getPublic').then(st => { if (live) return; load(st); render(); renderMaterials(); renderLanding(); }).catch(er => toast("Couldn't reach the Sheet: " + er.message));
}
