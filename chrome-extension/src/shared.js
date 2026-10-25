/*
 * EBPG Posting Helper: shared constants, the Event Hub message check, and the
 * text formatters used by the content scripts, the service worker and the pages.
 * Plain script (no modules) so Chrome can load it as a content script, a
 * service-worker import and a page script. Node tests load it with require().
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EBPG = root.EBPG || {}; root.EBPG.shared = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Pages allowed to send drafts. Must match the hub content script matches in manifest.json.
  const HUB_ORIGINS = ['https://ebpg-event-hub.netlify.app', 'http://localhost:8766'];

  const CHANNELS = ['partiful', 'luma', 'meetup', 'facebook', 'hylo', 'instagram'];

  const CHANNEL_INFO = {
    partiful: { name: 'Partiful', kind: 'event', url: 'https://partiful.com/create' },
    luma: { name: 'Luma', kind: 'event', url: 'https://lu.ma/create' },
    meetup: { name: 'Meetup', kind: 'event', setting: 'meetupUrl', hosts: ['meetup.com'] },
    facebook: { name: 'Facebook', kind: 'post', setting: 'facebookUrl', hosts: ['facebook.com'] },
    hylo: { name: 'Hylo', kind: 'post', setting: 'hyloUrl', hosts: ['hylo.com'] },
    instagram: { name: 'Instagram', kind: 'none', url: 'https://www.instagram.com/' }
  };

  const LIMITS = {
    title: 200,
    place: 200,
    address: 300,
    text: 20000,
    url: 2000,
    imageBytes: 5 * 1024 * 1024
  };

  // A draft fills a page only if it was sent (or re-opened from the side panel) this recently.
  const FRESH_MS = 30 * 60 * 1000;

  function hostMatches(hostname, domain) {
    const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return h === domain || h.endsWith('.' + domain);
  }

  // Which channel a site belongs to, from its hostname. Null for any other site.
  function channelForHost(hostname) {
    if (hostMatches(hostname, 'partiful.com')) return 'partiful';
    if (hostMatches(hostname, 'lu.ma') || hostMatches(hostname, 'luma.com')) return 'luma';
    if (hostMatches(hostname, 'meetup.com')) return 'meetup';
    if (hostMatches(hostname, 'facebook.com')) return 'facebook';
    if (hostMatches(hostname, 'hylo.com')) return 'hylo';
    return null;
  }

  // Normalizes a group link typed on the Options page. Returns the https URL, or null if it
  // is not on that channel's site (the helper only runs on those sites).
  function normalizeGroupUrl(channel, raw) {
    const info = CHANNEL_INFO[channel];
    if (!info || !info.hosts) return null;
    let s = String(raw || '').trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!info.hosts.some(d => hostMatches(u.hostname, d))) return null;
    u.protocol = 'https:';
    u.hash = '';
    return u.toString();
  }

  // Removes control characters (keeps tabs and new lines) and normalizes line endings.
  function cleanText(v, max) {
    if (typeof v !== 'string') return '';
    let s = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    s = s.replace(/[ \t]+\n/g, '\n').trim();
    if (s.length > max) s = s.slice(0, max).trimEnd();
    return s;
  }

  function cleanLine(v, max) {
    return cleanText(v, max * 2).replace(/\s+/g, ' ').trim().slice(0, max).trim();
  }

  function cleanDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
    const [y, m, d] = v.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
    return v;
  }

  function cleanTime(v) {
    return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '';
  }

  function cleanUrl(v) {
    if (typeof v !== 'string' || !v.trim() || v.length > LIMITS.url) return '';
    try {
      const u = new URL(v.trim());
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
    } catch (e) { return ''; }
  }

  // Decoded size of a base64 payload, without decoding it.
  function base64Bytes(b64) {
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.floor(b64.length * 3 / 4) - pad;
  }

  const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

  // Sentences for the organizer when the image has to be left out. The rest of the event
  // still goes through: the hub sends the flyer by itself, so refusing would block the fill.
  const IMAGE_NOTES = {
    unreadable: 'The image could not be read, so the helper left it out. Add it on the site yourself.',
    tooLarge: 'The image is larger than 5 MB, so the helper left it out. Add it on the site yourself.',
    wrongType: 'The image is not a PNG, JPEG, WebP or GIF, so the helper left it out. Add it on the site yourself.',
    notSaved: 'The helper could not save the image, so it left it out. Add it on the site yourself.'
  };

  // Checks an image data URL. Returns { value }, or { value: '', note } when it is left out.
  function cleanImage(v) {
    if (v == null || v === '') return { value: '' };
    if (typeof v !== 'string') return { value: '', note: IMAGE_NOTES.unreadable };
    // Check the size before running the regex on something huge.
    if (v.length > Math.ceil(LIMITS.imageBytes * 4 / 3) + 64) return { value: '', note: IMAGE_NOTES.tooLarge };
    const m = IMAGE_RE.exec(v);
    if (!m) return { value: '', note: IMAGE_NOTES.wrongType };
    if (base64Bytes(m[2]) > LIMITS.imageBytes) return { value: '', note: IMAGE_NOTES.tooLarge };
    return { value: v, type: 'image/' + m[1] };
  }

  // Cleans a draft from the Event Hub. Unknown keys are dropped; long text is cut to the
  // limit; bad dates, times, links and images are dropped. Returns { draft, imageNote? }
  // (imageNote says why the image was left out) or { error }.
  function sanitizeDraft(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'The event details were missing. Refresh the Event Hub and try again.' };
    const img = cleanImage(raw.imageDataUrl);
    const draft = {
      title: cleanLine(raw.title, LIMITS.title),
      date: cleanDate(raw.date),
      start: cleanTime(raw.start),
      end: cleanTime(raw.end),
      place: cleanLine(raw.place, LIMITS.place),
      address: cleanLine(raw.address, LIMITS.address),
      description: cleanText(raw.description, LIMITS.text),
      text: cleanText(raw.text, LIMITS.text),
      eventUrl: cleanUrl(raw.eventUrl),
      imageDataUrl: img.value
    };
    if (!draft.title) return { error: 'The event needs a title before the helper can fill a form.' };
    return img.note ? { draft, imageNote: img.note } : { draft };
  }

  /*
   * Checks a window message on an Event Hub page.
   * Returns:
   *   { ignore: true }                      not ours: leave it alone, do not reply
   *   { ok: true, channel, draft, imageNote? }  a valid fill request (imageNote: image left out)
   *   { ok: false, channel, message }       ours but unusable: reply with this message
   */
  function validateHubMessage(event, win) {
    if (!event || !win) return { ignore: true };
    if (event.source !== win) return { ignore: true };
    const origin = win.location && win.location.origin;
    if (!origin || event.origin !== origin || !HUB_ORIGINS.includes(origin)) return { ignore: true };
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== 'ebpg-hub') return { ignore: true };
    if (data.type !== 'fill') return { ignore: true };
    const channel = typeof data.channel === 'string' ? data.channel : '';
    if (!CHANNELS.includes(channel)) return { ok: false, channel, message: 'The helper does not know that site yet.' };
    const res = sanitizeDraft(data.draft);
    if (res.error) return { ok: false, channel, message: res.error };
    return res.imageNote ? { ok: true, channel, draft: res.draft, imageNote: res.imageNote } : { ok: true, channel, draft: res.draft };
  }

  function isFresh(record, now) {
    if (!record || !record.draft) return false;
    const t = Math.max(Number(record.timestamp) || 0, Number(record.openedAt) || 0);
    return now - t >= 0 && now - t < FRESH_MS;
  }

  // ---- Formatting (US English, the Guild's audience) ----

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function dateParts(iso) {
    if (!cleanDate(iso)) return null;
    const [y, m, d] = iso.split('-').map(Number);
    return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
  }

  // "Sunday, October 26, 2026"
  function longDate(iso) {
    const p = dateParts(iso);
    return p ? `${DAYS[p.dow]}, ${MONTHS[p.m - 1]} ${p.d}, ${p.y}` : '';
  }

  const pad2 = n => String(n).padStart(2, '0');

  // Date in the shape a text box asks for. Format is read from its placeholder.
  function dateAs(iso, format) {
    const p = dateParts(iso);
    if (!p) return '';
    const f = String(format || '').toLowerCase();
    if (/y{4}\s*-\s*m{2}\s*-\s*d{2}/.test(f)) return iso;
    if (/d{1,2}\s*[/.-]\s*m{1,2}\s*[/.-]\s*y{2,4}/.test(f)) return `${pad2(p.d)}/${pad2(p.m)}/${p.y}`;
    if (/[a-z]{3},? [a-z]{3} \d/.test(f) || /\bmmm\b/.test(f)) return `${MONTHS[p.m - 1].slice(0, 3)} ${p.d}, ${p.y}`;
    return `${pad2(p.m)}/${pad2(p.d)}/${p.y}`;
  }

  // "10:00 AM"
  function time12(hhmm) {
    if (!cleanTime(hhmm)) return '';
    let [h, m] = hhmm.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${pad2(m)} ${ap}`;
  }

  // "10:00 AM to 1:00 PM"
  function timeRange(start, end) {
    const a = time12(start), b = time12(end);
    if (a && b) return `${a} to ${b}`;
    return a || '';
  }

  // "Grace Room, Oakland Peace Center, 111 Fairmount Ave" without repeating the place.
  function placeLine(place, address) {
    const p = String(place || '').trim(), a = String(address || '').trim();
    if (!a) return p;
    if (!p) return a;
    if (a.toLowerCase().includes(p.toLowerCase())) return a;
    return `${p}, ${a}`;
  }

  // The rows shown with Copy buttons, in order. Rows with nothing in them are left out.
  function copyRows(draft) {
    const d = draft || {};
    const rows = [
      { key: 'title', label: 'Title', value: d.title || '' },
      { key: 'date', label: 'Date', value: longDate(d.date) },
      { key: 'time', label: 'Time', value: timeRange(d.start, d.end) },
      { key: 'place', label: 'Place', value: placeLine(d.place, d.address) },
      { key: 'description', label: 'Description', value: d.description || '' },
      { key: 'text', label: 'Full text', value: d.text || '' },
      { key: 'link', label: 'Event link', value: d.eventUrl || '' }
    ];
    // When the hub sends the same words as description and full text, show them once.
    if (rows[4].value && rows[4].value === rows[5].value) rows.splice(4, 1);
    return rows.filter(r => r.value);
  }

  // A safe file name for the image download: "workday-7-flyer.png".
  function imageFileName(draft) {
    const d = draft || {};
    const ext = (/^data:image\/(png|jpeg|webp|gif)/.exec(d.imageDataUrl || '') || [, 'png'])[1].replace('jpeg', 'jpg');
    const slug = String(d.title || 'event').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'event';
    return `${slug}.${ext}`;
  }

  // "just now", "4 minutes ago", "2 hours ago", "3 days ago"
  function ago(ts, now) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
    const h = Math.round(m / 60);
    if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
    const d = Math.round(h / 24);
    return d === 1 ? '1 day ago' : `${d} days ago`;
  }

  function dataUrlToBytes(dataUrl, atobFn) {
    const m = IMAGE_RE.exec(dataUrl || '');
    if (!m) return null;
    const bin = (atobFn || atob)(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, type: 'image/' + m[1] };
  }

  return {
    HUB_ORIGINS, CHANNELS, CHANNEL_INFO, LIMITS, FRESH_MS, IMAGE_NOTES,
    hostMatches, channelForHost, normalizeGroupUrl,
    cleanText, cleanDate, cleanTime, cleanUrl, cleanImage, sanitizeDraft, validateHubMessage, isFresh,
    longDate, dateAs, time12, timeRange, placeLine, copyRows, imageFileName, ago, dataUrlToBytes
  };
});
