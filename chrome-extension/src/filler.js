/*
 * EBPG Posting Helper: finds the fields of a "create event" or "new post" form and fills
 * them from a draft. Every rule here is a heuristic (see README "Which parts are guesses"):
 * the sites change their markup often, so fields are found by their visible label,
 * placeholder, aria-label, name and nearby text rather than by fixed selectors.
 *
 * This file never clicks anything and never submits a form. People review and publish.
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./shared.js') : root.EBPG.shared);
  if (isNode) module.exports = api;
  else { root.EBPG = root.EBPG || {}; root.EBPG.filler = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  'use strict';

  // ---------- Reading what a field is for ----------

  // Lowercase words only: "Event's Name*" -> "events name".
  function norm(s) {
    return String(s || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function textOf(node) {
    return node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function editableAttr(el) {
    const v = el.getAttribute && el.getAttribute('contenteditable');
    return v !== null && v !== undefined && v.toLowerCase() !== 'false';
  }

  function isContentEditable(el) {
    return !!el && el.nodeType === 1 && editableAttr(el);
  }

  // The outermost editable element (rich editors nest contenteditable nodes).
  function isEditableRoot(el) {
    if (!editableAttr(el)) return false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.hasAttribute('contenteditable')) return !editableAttr(p);
    }
    return true;
  }

  function inputType(el) {
    return el.tagName === 'INPUT' ? String(el.getAttribute('type') || 'text').toLowerCase() : '';
  }

  const INPUT_TYPES = new Set(['text', 'date', 'time', 'datetime-local']);
  const SKIP_AUTOCOMPLETE = /\b(email|tel|username|current-password|new-password|one-time-code|cc-|given-name|family-name|bday)/;

  function isVisible(el, win) {
    if (el.hidden || el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = win.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  }

  function byIds(doc, ids) {
    return String(ids || '').split(/\s+/).filter(Boolean)
      .map(id => textOf(doc.getElementById(id))).filter(Boolean).join(' ');
  }

  function hasField(node) {
    return !!(node && node.querySelector && node.querySelector('input, textarea, select, [contenteditable]'));
  }

  // Short text just before the field: "<div>Event name</div><input>" style forms.
  function nearbyText(el) {
    const body = el.ownerDocument.body;
    let node = el;
    for (let depth = 0; depth < 4 && node && node !== body; depth++) {
      let sib = node.previousElementSibling;
      for (let hops = 0; sib && hops < 3; hops++, sib = sib.previousElementSibling) {
        if (hasField(sib) || /^(INPUT|TEXTAREA|SELECT)$/.test(sib.tagName)) return '';
        const t = textOf(sib);
        if (t) return t.length <= 80 ? t : '';
      }
      node = node.parentElement;
      if (node && hasField(node) && node.querySelectorAll('input, textarea, select, [contenteditable]').length > 1) {
        // Stop when the wrapper holds other fields too; its text belongs to them.
        break;
      }
    }
    return '';
  }

  // Placeholder text drawn by rich editors (Lexical, ProseMirror, Draft.js) next to the box.
  function editorPlaceholder(el) {
    const bits = [];
    ['aria-placeholder', 'data-placeholder', 'placeholder'].forEach(a => { if (el.getAttribute(a)) bits.push(el.getAttribute(a)); });
    const inner = el.querySelector('[data-placeholder]');
    if (inner) bits.push(inner.getAttribute('data-placeholder'));
    for (let p = el.parentElement, d = 0; p && d < 3 && !bits.length; p = p.parentElement, d++) {
      for (const c of p.children) {
        if (c !== el && !c.contains(el) && /placeholder/i.test(String(c.className || '')) && !hasField(c)) bits.push(textOf(c));
      }
    }
    return bits.filter(Boolean).join(' ');
  }

  // Everything that says what a field is for, grouped by how much it can be trusted.
  function describe(el) {
    const doc = el.ownerDocument;
    const labels = [];
    if (el.labels) for (const l of el.labels) labels.push(textOf(l));
    if (!labels.length) { const wrap = el.closest('label'); if (wrap) labels.push(textOf(wrap)); }
    const strong = [labels.join(' '), el.getAttribute('aria-label'), byIds(doc, el.getAttribute('aria-labelledby')), el.getAttribute('title')]
      .filter(Boolean).join(' ');
    const rawPlaceholder = isContentEditable(el) ? editorPlaceholder(el) : (el.getAttribute('placeholder') || '');
    const attrs = ['name', 'id', 'data-testid', 'data-test-id', 'data-qa', 'autocomplete']
      .map(a => el.getAttribute(a) || '').join(' ').replace(/[_-]+/g, ' ');
    return {
      strong: norm(strong),
      placeholder: norm(rawPlaceholder),
      rawPlaceholder: rawPlaceholder.toLowerCase(),
      attrs: norm(attrs),
      near: norm(nearbyText(el))
    };
  }

  // ---------- Field kinds ----------

  const RULES = {
    title: {
      pos: [/\b(events?|activity|meetup|gathering|listing|post) (name|title)\b/, /\btitle\b/, /\bname (of )?(your |the |this )?(event|gathering)\b/,
        /\buntitled\b/, /^name$/, /\bheadline\b/, /\bwhat are you (hosting|planning|calling it)\b/],
      neg: /\b(your|first|last|full|user|host|venue|location|place|group|organi[sz]er|display|company|file|contact|guest|co ?host) ?name\b|\bsearch\b|\be ?mail\b|\bphone\b|\bpassword\b|\burl\b|\blink\b|\btickets?\b|\bquestion\b|\btags?\b|\bsubtitle\b|\bcomment\b|\bseo\b/
    },
    description: {
      pos: [/\bdescri(be|ption)\b/, /\bdetails?\b/, /\babout\b/, /\btell (people|guests|attendees|everyone|folks)\b/, /\bsummary\b/, /\bagenda\b/,
        /\bwhat (is|s) (it|this|this event|the event) about\b/, /\bwhat (should|will) (people|guests|attendees) (know|expect)\b/],
      neg: /\b(location|address|venue|tickets?|payment|contact|seo|search|comment|reply|bio|group description|short description)\b/
    },
    body: {
      pos: [/\bwhats on your mind\b/, /\bwrite something\b/, /\bcreate a (public |new )?post\b/, /\bstart a (discussion|post|conversation)\b/,
        /\bshare (something|an update|whats|your)\b/, /\bwrite a post\b/, /\bpost (text|body|content)\b/, /\bwhats happening\b/,
        /\bwhat do you want to (share|talk about|say)\b/, /\badd (a )?post\b/],
      neg: /\b(search|comment|reply|messenger|chat)\b/
    },
    location: {
      pos: [/\blocation\b/, /\bwhere\b/, /\bvenue\b/, /\bplace\b/, /\bmeeting (point|spot)\b/, /\baddress\b/],
      neg: /\b(e ?mail|web|ip|wallet|billing|shipping|return) address\b|\bsearch (facebook|meetup|hylo|people|groups|for people)\b|\burl\b|\bzoom\b|\bmeeting link\b|\bdescri/
    },
    address: {
      pos: [/\b(street )?address\b/],
      neg: /\b(e ?mail|web|ip|wallet|billing|shipping|return) address\b|\burl\b/
    }
  };

  const WEIGHTS = [['strong', 3], ['placeholder', 2.5], ['attrs', 1.5], ['near', 1]];

  function scoreKind(d, rule) {
    const own = [d.strong, d.placeholder, d.attrs].join(' ');
    if (rule.neg.test(own)) return 0;
    let best = 0;
    for (const [src, w] of WEIGHTS) {
      const t = d[src];
      if (!t || (src === 'near' && rule.neg.test(t))) continue;
      if (rule.pos.some(re => re.test(t))) best = Math.max(best, w);
    }
    return best;
  }

  const DATE_FMT = /\b(mm|dd)\s*[/.-]\s*(dd|mm)\s*[/.-]\s*(yy|yyyy)\b|\byyyy\s*-\s*mm\s*-\s*dd\b/;
  const TIME_FMT = /\bhh\s*:\s*mm\b|--\s*:\s*--|^\s*\d{1,2}:\d{2}\s*([ap]\.?m\.?)?\s*$/;
  const DT_NEG = /\b(birth|birthday|dob|expir\w*|deadline|rsvp by|cutoff|closes)\b/;
  const END_RE = /\b(end|ends|ending|until|finish|finishes|stop)\b/;
  const START_RE = /\b(start|starts|starting|begin|begins|from)\b/;

  function looksLikeTimeSelect(el) {
    if (el.tagName !== 'SELECT') return false;
    let n = 0;
    for (const o of el.options) if (/^\s*\d{1,2}:\d{2}\s*([ap]\.?m\.?)?\s*$/i.test(o.textContent) || /^\d{2}:\d{2}$/.test(o.value)) n++;
    return n >= 4;
  }

  // 'date', 'time', 'datetime' or null.
  function dateTimeKind(el, d) {
    const type = inputType(el);
    const own = [d.strong, d.placeholder, d.attrs].join(' ');
    if (DT_NEG.test(own)) return null;
    if (el.tagName === 'SELECT') return looksLikeTimeSelect(el) ? 'time' : null;
    if (type === 'date') return 'date';
    if (type === 'time') return 'time';
    if (type === 'datetime-local') return 'datetime';
    if (el.tagName !== 'INPUT') return null;
    const value = String(el.value || '');
    if (DATE_FMT.test(d.rawPlaceholder) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
    if (TIME_FMT.test(d.rawPlaceholder) || /^\d{1,2}:\d{2}\s*([ap]m)?$/i.test(value)) return 'time';
    for (const t of [own, d.near]) {
      if (!t || DT_NEG.test(t)) continue;
      const hasDate = /\b(date|day)\b/.test(t), hasTime = /\btime\b/.test(t);
      if (hasDate && !hasTime) return 'date';
      if (hasTime && !hasDate) return 'time';
      if (hasDate || hasTime) return null;
    }
    return null;
  }

  // true for end, false for start, null if the label does not say.
  function endSide(d) {
    for (const t of [[d.strong, d.placeholder, d.attrs].join(' '), d.near]) {
      if (END_RE.test(t)) return true;
      if (START_RE.test(t)) return false;
    }
    return null;
  }

  function isExcluded(el) {
    if (el.closest('[role="banner"], [role="navigation"], nav, [role="search"], [data-ebpg-panel]')) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'searchbox') return true;
    const ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
    if (SKIP_AUTOCOMPLETE.test(ac)) return true;
    const im = String(el.getAttribute('inputmode') || '').toLowerCase();
    return im === 'email' || im === 'tel';
  }

  // Fields a person could type into, in page order.
  function candidates(doc, win) {
    const out = [];
    doc.querySelectorAll('input, textarea, select, [contenteditable]').forEach(el => {
      if (el.tagName === 'INPUT' && !INPUT_TYPES.has(inputType(el))) return;
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && (el.disabled || el.readOnly)) return;
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !isEditableRoot(el)) return;
      if (isExcluded(el) || !isVisible(el, win)) return;
      out.push(el);
    });
    return out;
  }

  /*
   * Works out which field is which. Returns:
   *   { mode: 'event' | 'post' | null, fields: Map(kind -> element) }
   * kinds: title, date, endDate, start, end, datetime, endDatetime, location, address, description, body
   * mode null means "this does not look like the form", so nothing is filled.
   */
  function scan(doc, opts) {
    const o = opts || {};
    const win = doc.defaultView;
    const fields = new Map();
    const dates = [], times = [], datetimes = [], scored = [];
    candidates(doc, win).forEach((el, index) => {
      const d = describe(el);
      // Site search boxes ("Search Facebook") are never form fields; venue search boxes are.
      const searchy = [d.strong, d.placeholder].find(t => /^\s*search\b/.test(t));
      if (searchy && !/\b(venue|location|address|place|where)\b/.test(searchy)) return;
      const dt = dateTimeKind(el, d);
      if (dt) {
        const item = { el, end: endSide(d) };
        (dt === 'date' ? dates : dt === 'time' ? times : datetimes).push(item);
        return;
      }
      if (el.tagName === 'SELECT') return;
      const multi = el.tagName === 'TEXTAREA' || isContentEditable(el);
      // Rich editors drop their placeholder once they hold text, so remember what a box was.
      const known = o.memory && o.memory.get(el);
      if (known && RULES[known]) scored.push({ el, kind: known, score: 2.75, index });
      for (const kind of Object.keys(RULES)) {
        if (kind === 'body' && !multi) continue;
        // Location boxes are one-line inputs (often with suggestions), never a long text box.
        if ((kind === 'location' || kind === 'address') && el.tagName !== 'INPUT') continue;
        const s = scoreKind(d, RULES[kind]);
        // Long text boxes are a better match for descriptions; one-line boxes for the rest.
        if (s > 0) scored.push({ el, kind, score: s + (kind === 'description' && multi ? 0.5 : 0) + (kind === 'title' && !multi ? 0.25 : 0), index });
      }
    });

    // Pair start/end. Labels win; otherwise the first unlabeled one is the start, the next the end.
    function pair(list, startKind, endKind) {
      const start = list.find(x => x.end === false) || list.find(x => x.end === null);
      const end = list.find(x => x.end === true) || list.find(x => x.end === null && x !== start && start && list.indexOf(x) > list.indexOf(start));
      if (start) fields.set(startKind, start.el);
      if (end && end !== start) fields.set(endKind, end.el);
    }
    pair(dates, 'date', 'endDate');
    pair(times, 'start', 'end');
    pair(datetimes, 'datetime', 'endDatetime');

    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const used = new Set();
    const kindOrder = ['title', 'location', 'description', 'body', 'address'];
    for (const kind of kindOrder) {
      const best = scored.find(x => x.kind === kind && !used.has(x.el));
      if (best) { fields.set(kind, best.el); used.add(best.el); }
    }
    // A field that only says "address" is the location when there is no other location box.
    if (!fields.has('location') && fields.has('address')) { fields.set('location', fields.get('address')); fields.delete('address'); }

    const has = k => fields.has(k);
    const eventBits = ['date', 'start', 'datetime', 'location', 'description'].filter(has).length;
    const postSite = o.channel ? (shared.CHANNEL_INFO[o.channel] || {}).kind === 'post' : true;
    let mode = null;
    if (has('title') && (eventBits >= 1 || o.createPage)) mode = 'event';
    else if (!has('title') && eventBits >= 3) mode = 'event';
    else if (postSite && (has('body') || (has('description') && !has('title')))) mode = 'post';

    if (mode === 'event') {
      if (has('body') && !has('description')) fields.set('description', fields.get('body'));
      fields.delete('body');
    } else if (mode === 'post') {
      const box = fields.get('body') || fields.get('description');
      fields.clear();
      fields.set('body', box);
    } else {
      fields.clear();
    }
    if (o.memory) fields.forEach((el, kind) => o.memory.set(el, kind));
    return { mode, fields };
  }

  // ---------- Values ----------

  function dateFor(el, iso, time) {
    const type = inputType(el);
    if (type === 'date') return iso;
    if (type === 'datetime-local') return `${iso}T${time || '00:00'}`;
    const ph = String(el.getAttribute('placeholder') || '');
    const current = String(el.value || '').trim();
    // No placeholder: copy the shape of the date the site already shows.
    if (!ph && /^\d{4}-\d{2}-\d{2}$/.test(current)) return iso;
    if (!ph && /^[A-Za-z]{3,9}\.? \d{1,2}, \d{4}$/.test(current)) return shared.dateAs(iso, 'mmm d, yyyy');
    return shared.dateAs(iso, ph || 'mm/dd/yyyy');
  }

  function timeFor(el, hhmm) {
    if (inputType(el) === 'time') return hhmm;
    if (el.tagName === 'SELECT') {
      const want = [hhmm, shared.time12(hhmm).toLowerCase(), shared.time12(hhmm).replace(' ', '').toLowerCase()];
      for (const opt of el.options) {
        const t = opt.textContent.trim().toLowerCase().replace(/\./g, '');
        if (want.includes(opt.value) || want.includes(t)) return opt.value;
      }
      return '';
    }
    const ph = String(el.getAttribute('placeholder') || '');
    const current = String(el.value || '');
    const twentyFour = /HH/.test(ph) || (/^\d{2}:\d{2}$/.test(current) && !/[ap]m/i.test(ph));
    return twentyFour ? hhmm : shared.time12(hhmm);
  }

  function valueFor(kind, el, draft, fields) {
    const d = draft || {};
    switch (kind) {
      case 'title': return d.title || '';
      case 'description': return d.description || d.text || '';
      case 'body': return d.text || d.description || '';
      case 'location': return fields.has('address') ? (d.place || d.address || '') : shared.placeLine(d.place, d.address);
      case 'address': return d.address || '';
      case 'date': case 'endDate': return d.date ? dateFor(el, d.date, '') : '';
      case 'datetime': return d.date ? dateFor(el, d.date, d.start) : '';
      case 'endDatetime': return d.date && d.end ? dateFor(el, d.date, d.end) : '';
      case 'start': return d.start ? timeFor(el, d.start) : '';
      case 'end': return d.end ? timeFor(el, d.end) : '';
      default: return '';
    }
  }

  function currentValue(el) {
    return isContentEditable(el) ? textOf(el) : String(el.value || '');
  }

  // ---------- Setting values the way React, Vue and rich editors expect ----------

  function fire(el, win, type, init) {
    const C = (type === 'input' || type === 'beforeinput') && typeof win.InputEvent === 'function' ? win.InputEvent : win.Event;
    return el.dispatchEvent(new C(type, Object.assign({ bubbles: true, cancelable: type === 'beforeinput' }, init || {})));
  }

  // Native setter, then input + change, so React's value tracker sees a real change.
  function setInputValue(el, value, win) {
    if (el.tagName === 'SELECT') {
      const proto = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value');
      proto.set.call(el, value);
      fire(el, win, 'input');
      fire(el, win, 'change');
      return el.value === value;
    }
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    let v = value;
    if (el.maxLength > 0 && v.length > el.maxLength) v = v.slice(0, el.maxLength);
    try { el.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
    setter.call(el, v);
    fire(el, win, 'input', { inputType: 'insertReplacementText', data: v });
    fire(el, win, 'change');
    try { el.blur(); } catch (e) { /* ignore */ }
    return String(el.value || '').length > 0;
  }

  function selectContents(el, win) {
    try {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      const sel = win.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* no selection support */ }
  }

  // Rich editors: a plain-text paste first (they all handle it, line breaks included),
  // then execCommand('insertText'), then a beforeinput/input pair as a last resort.
  function setEditableValue(el, value, win) {
    const doc = el.ownerDocument;
    try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    selectContents(el, win);
    if (typeof win.DataTransfer === 'function' && typeof win.ClipboardEvent === 'function') {
      try {
        const dt = new win.DataTransfer();
        dt.setData('text/plain', value);
        const ev = new win.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        if (ev.defaultPrevented) return true;
      } catch (e) { /* fall through */ }
    }
    if (typeof doc.execCommand === 'function') {
      try {
        if (doc.execCommand('insertText', false, value) && textOf(el)) return true;
      } catch (e) { /* fall through */ }
    }
    const handled = !fire(el, win, 'beforeinput', { inputType: 'insertText', data: value });
    if (!handled) {
      const lines = value.split('\n');
      if (lines.length === 1) el.textContent = value;
      else {
        el.replaceChildren(...lines.map(line => {
          const p = doc.createElement('p');
          if (line) p.textContent = line; else p.appendChild(doc.createElement('br'));
          return p;
        }));
      }
      fire(el, win, 'input', { inputType: 'insertText', data: value });
    }
    return textOf(el).length > 0;
  }

  function setFieldValue(el, value, win) {
    return isContentEditable(el) ? setEditableValue(el, value, win) : setInputValue(el, value, win);
  }

  // ---------- Image ----------

  function acceptsType(input, type) {
    const accept = String(input.getAttribute('accept') || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    if (!accept.length) return true;
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[type];
    return accept.some(a => a === type || a === 'image/*' || a === ext || (ext === '.jpg' && a === '.jpeg'));
  }

  const IMAGE_HINT = /\b(cover|image|photo|picture|flyer|banner|poster|upload|media)\b/;

  /*
   * The part of the page that holds the form being filled: the dialog or form around every
   * filled box, or else the nearest element that holds them all. Other uploaders on the page
   * (cover photo, profile picture, chat) sit outside it, so the image never goes to them.
   */
  function formScope(els) {
    const list = els.filter(el => el && el.nodeType === 1);
    if (!list.length) return null;
    let common = list[0].parentElement;
    while (common && !list.every(el => common.contains(el))) common = common.parentElement;
    if (!common) return null;
    return common.closest('[role="dialog"], dialog') || common.closest('form') || common;
  }

  // The best image upload box inside root (an element or the whole document).
  function findImageInput(root, type) {
    let best = null, bestScore = -1;
    if (!root) return null;
    root.querySelectorAll('input[type="file"]').forEach(input => {
      if (input.disabled || isExcluded(input) || !acceptsType(input, type)) return;
      const d = describe(input);
      const accept = String(input.getAttribute('accept') || '').toLowerCase();
      let score = /image/.test(accept) ? 2 : 0;
      if (IMAGE_HINT.test([d.strong, d.placeholder, d.attrs, d.near].join(' '))) score += 1;
      if (/\b(video|audio|pdf|csv|document)\b/.test(accept) && !/image/.test(accept)) score -= 3;
      if (score > bestScore) { best = input; bestScore = score; }
    });
    return bestScore >= 0 ? best : null;
  }

  function attachImage(input, draft, win) {
    const parsed = shared.dataUrlToBytes(draft.imageDataUrl, s => win.atob(s));
    if (!parsed || typeof win.DataTransfer !== 'function') return false;
    try {
      const file = new win.File([parsed.bytes], shared.imageFileName(draft), { type: parsed.type });
      const dt = new win.DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      fire(input, win, 'input');
      fire(input, win, 'change');
      return !!(input.files && input.files.length);
    } catch (e) {
      return false;
    }
  }

  // ---------- The whole pass ----------

  const TEXT_KINDS = new Set(['title', 'description', 'body', 'location', 'address']);

  /*
   * Fills what it can. Options:
   *   channel      'partiful' | 'luma' | ...   (post sites allow the free-text composer)
   *   createPage   true on a /create style URL (a title box alone is then enough)
   *   force        true for "Fill again": overwrite whatever is there
   *   skip(el)     return true to leave a field alone (already filled, or the person typed in it)
   *   withImage    false to skip the image (already attached)
   *   memory       a WeakMap kept between passes: which box was which
   * Returns { mode, filled: [{kind, el}], failed: [kind], kept: [kind], image: 'attached'|'failed'|'no-field'|'none' }
   */
  function fill(doc, draft, opts) {
    const o = opts || {};
    const win = doc.defaultView;
    const plan = scan(doc, o);
    const result = { mode: plan.mode, filled: [], failed: [], kept: [], image: 'none' };
    if (!plan.mode || !draft) return result;
    for (const [kind, el] of plan.fields) {
      if (o.skip && o.skip(el)) continue;
      const value = valueFor(kind, el, draft, plan.fields);
      if (!value) continue;
      const now = currentValue(el);
      if (now === value || (isContentEditable(el) && now === value.replace(/\s+/g, ' ').trim())) { result.filled.push({ kind, el }); continue; }
      // Without "Fill again", never type over words that are already in a text box.
      if (!o.force && TEXT_KINDS.has(kind) && now.trim()) { result.kept.push(kind); continue; }
      if (setFieldValue(el, value, win)) result.filled.push({ kind, el });
      else result.failed.push(kind);
    }
    if (draft.imageDataUrl && o.withImage !== false) {
      const type = (/^data:(image\/[a-z]+);/.exec(draft.imageDataUrl) || [])[1];
      const input = findImageInput(formScope([...plan.fields.values()]), type);
      if (!input) result.image = 'no-field';
      else result.image = attachImage(input, draft, win) ? 'attached' : 'failed';
    }
    return result;
  }

  return { norm, describe, scan, fill, valueFor, setFieldValue, setInputValue, setEditableValue, formScope, findImageInput, attachImage, isContentEditable, candidates };
});
