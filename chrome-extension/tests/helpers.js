'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { png, render } = require('../tools/make-icons.js');

const ROOT = path.join(__dirname, '..');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const TINY_PNG = 'data:image/png;base64,' + png(8, render(8)).toString('base64');

function draft(extra) {
  return Object.assign({
    title: 'Workday #7: Sheet mulching the food forest',
    date: '2026-11-08',
    start: '10:00',
    end: '13:00',
    place: 'Oakland Peace Center',
    address: '111 Fairmount Ave, Oakland, CA 94611',
    description: 'Bring gloves and a water bottle. We will sheet mulch the new beds and plant fava beans.',
    text: 'Workday #7 is Sunday, November 8 at 10 AM at the Oakland Peace Center.\n\nBring gloves and a water bottle.\nNew faces very welcome!',
    eventUrl: 'https://ebpg-event-hub.netlify.app/#event=w7',
    imageDataUrl: ''
  }, extra || {});
}

function dom(html, url) {
  return new JSDOM(html, { url: url || 'https://partiful.com/create', pretendToBeVisual: true });
}

/*
 * Mimics React's controlled-input value tracking. React redefines `value` on the element
 * itself and remembers the last value set through it; an input event only reaches the
 * component's onChange when the real DOM value differs from that remembered value. So a
 * plain `el.value = x` is silently ignored, while the prototype setter works.
 */
function reactify(el) {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  let tracked = desc.get.call(el);
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { tracked = String(v); desc.set.call(this, v); }
  });
  const state = { value: tracked, changes: 0 };
  el.addEventListener('input', () => {
    const now = desc.get.call(el);
    if (now !== tracked) { tracked = now; state.value = now; state.changes++; }
  });
  return state;
}

// jsdom has no DataTransfer or ClipboardEvent; these stand-ins behave like Chrome's for our use.
function addClipboardSupport(win) {
  win.DataTransfer = class {
    constructor() { this._files = []; this._data = {}; this.items = { add: f => { this._files.push(f); } }; }
    get files() { return this._files; }
    setData(t, v) { this._data[t] = String(v); }
    getData(t) { return this._data[t] || ''; }
  };
  win.ClipboardEvent = class extends win.Event {
    constructor(type, init) { super(type, init); this.clipboardData = (init && init.clipboardData) || null; }
  };
}

// jsdom's input.files only accepts a real FileList; let tests assign the stand-in list.
function allowFiles(input) {
  let files = [];
  Object.defineProperty(input, 'files', { configurable: true, get() { return files; }, set(v) { files = v; } });
}

// A Lexical/ProseMirror-like editor: handles plain-text paste itself, one <p> per line.
function richEditor(el) {
  const state = { pastes: 0 };
  el.addEventListener('paste', e => {
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    state.pastes++;
    const doc = el.ownerDocument;
    el.replaceChildren(...text.split('\n').map(line => {
      const p = doc.createElement('p');
      if (line) p.textContent = line; else p.appendChild(doc.createElement('br'));
      return p;
    }));
  });
  return state;
}

// Records clicks on buttons and form submissions so tests can prove nothing was published.
function watchSubmits(doc) {
  const log = [];
  doc.addEventListener('submit', e => { log.push('submit'); e.preventDefault(); }, true);
  doc.addEventListener('click', e => {
    const t = e.target;
    if (t && t.closest && t.closest('button, [role="button"], input[type="submit"]')) log.push('click:' + (t.id || t.textContent.trim()));
  }, true);
  return log;
}

// In-memory chrome.storage area with the promise API.
function storageArea(initial) {
  const data = Object.assign({}, initial || {});
  return {
    data,
    async get(keys) {
      if (keys == null) return JSON.parse(JSON.stringify(data));
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      list.forEach(k => { if (k in data) out[k] = JSON.parse(JSON.stringify(data[k])); });
      return out;
    },
    async set(obj) { Object.entries(obj).forEach(([k, v]) => { data[k] = JSON.parse(JSON.stringify(v)); }); },
    async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => { delete data[k]; }); }
  };
}

const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));

module.exports = { ROOT, fixture, draft, dom, reactify, addClipboardSupport, allowFiles, richEditor, watchSubmits, storageArea, tick, TINY_PNG };
