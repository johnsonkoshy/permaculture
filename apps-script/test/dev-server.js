/* Serve the built page with a fake google.script.run that calls Code.js
   running on the mock. Run: node test/dev-server.js, open http://localhost:8766/
   GET /site serves the Netlify build, calling the mock through POST /_api (doPost), and /ebpg-posting-helper.zip its Posting Helper zip.
   GET /_state dumps the mock Sheet and the emails it "sent".

   Slow or failing Sheet, for trying the save status and retries (test only; the page knows nothing of it):
     GET /_ctl?latency=3000&fail=saveEvent   every /_api call waits 3 s, and saveEvent answers with an HTML error page
     GET /_ctl?latency=0&fail=               back to normal (fail takes a comma-separated list of functions)
     GET /_ctl                               shows the current settings
   One call can also carry its own: POST /_api?latency=500&fail=signIn
   PORT=9000 node test/dev-server.js serves on another port. The organizer code is garden-dev-1234 (CODE=... to change it).
   GET /_ctl?quota=20 sets how many emails the mock Gmail has left today. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeGas } = require('./gas-mock');

// a new Sheet's organizer code is blank (nobody can sign in), so the dev Sheet gets this one
const CODE = process.env.CODE || 'garden-dev-1234';
const g = makeGas({ page: path.join(__dirname, '..', 'dist', 'index.html'), settings: { ORGANIZER_CODE: CODE } });
// the mock geocoder knows a few towns, so a garden added on the Gardens page lands about where it should
// (anything else: near the Peace Center; an address with "Nowhere" in it: not found)
const TOWNS = [[/berkeley/i, 37.8695, -122.2705], [/richmond/i, 37.9358, -122.3477], [/san francisco/i, 37.7749, -122.4194], [/fruitvale/i, 37.7748, -122.2241], [/alameda/i, 37.7652, -122.2416]];
g.geo.find = addr => { if (/nowhere/i.test(addr)) return null; const t = TOWNS.find(([re]) => re.test(addr)); return t ? { lat: t[1], lng: t[2] } : { lat: 37.81, lng: -122.25 }; };
const ctl = { latency: 0, fail: '' };
const SHIM = `<script>(() => {
  const runner = (ok, no) => new Proxy({}, { get: (_, fn) => {
    if (fn === 'withSuccessHandler') return f => runner(f, no);
    if (fn === 'withFailureHandler') return f => runner(ok, f);
    return (...args) => fetch('/_rpc/' + fn, { method: 'POST', body: JSON.stringify(args) }).then(r => r.json())
      .then(r => r.error ? no && no(new Error(r.error)) : ok && ok(r.value));
  } });
  window.google = { script: { run: runner() } };
})();</script>`;
// what Apps Script sends when it falls over: a web page, not JSON
const ERROR_PAGE = '<!DOCTYPE html><html><head><title>Error</title></head><body><p>Sorry, unable to open the file at this time.</p></body></html>';
const latencyOf = v => Math.max(0, Math.min(60000, Number(v) || 0));
const failing = (list, fn) => String(list || '').split(',').map(s => s.trim()).filter(Boolean).includes(fn);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  if (url.pathname === '/') {
    const out = g.ctx.doGet({ parameter: Object.fromEntries(url.searchParams) });
    return send(200, 'text/html; charset=utf-8', SHIM + out.content);
  }
  if (url.pathname === '/site') {
    const api = 'http://' + (req.headers.host || 'localhost:8766') + '/_api';
    const html = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8').replace(/https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec/, api);
    return send(200, 'text/html; charset=utf-8', html);
  }
  if (url.pathname === '/og.jpg') return send(200, 'image/jpeg', fs.readFileSync(path.join(__dirname, '..', 'site', 'og.jpg'))); // the share preview image
  if (url.pathname === '/ebpg-posting-helper.zip') { // the Posting Helper's install zip, as Netlify serves it
    const zip = path.join(__dirname, '..', 'site', 'ebpg-posting-helper.zip');
    return fs.existsSync(zip) ? send(200, 'application/zip', fs.readFileSync(zip)) : send(404, 'text/plain', 'not built: run python3 build.py');
  }
  if (url.pathname === '/_ctl') {
    if (url.searchParams.has('latency')) ctl.latency = latencyOf(url.searchParams.get('latency'));
    if (url.searchParams.has('fail')) ctl.fail = url.searchParams.get('fail');
    if (url.searchParams.has('quota')) g.mailbox.quota = Math.max(0, Number(url.searchParams.get('quota')) || 0);
    return send(200, 'application/json', JSON.stringify(ctl));
  }
  if (url.pathname === '/_api' && req.method === 'POST') {
    const latency = url.searchParams.has('latency') ? latencyOf(url.searchParams.get('latency')) : ctl.latency;
    const fail = url.searchParams.has('fail') ? url.searchParams.get('fail') : ctl.fail;
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => setTimeout(() => {
      let fn = '';
      try { fn = JSON.parse(body).fn; } catch {}
      if (failing(fail, fn)) return send(502, 'text/html; charset=utf-8', ERROR_PAGE);
      send(200, 'application/json', g.ctx.doPost({ postData: { contents: body } }).content);
    }, latency));
    return;
  }
  if (url.pathname === '/_state') {
    return send(200, 'application/json', JSON.stringify({ sheets: Object.fromEntries([...g.sheets].map(([k, s]) => [k, s.table()])), mail: g.mail, calendar: g.calendar }));
  }
  if (url.pathname === '/_set') { // edit a mock Sheet cell by hand: /_set?tab=Events&r=2&c=9&v=Phil
    g.sheets.get(url.searchParams.get('tab')).set(+url.searchParams.get('r'), +url.searchParams.get('c'), url.searchParams.get('v'));
    return send(200, 'text/plain', 'ok');
  }
  const m = url.pathname.match(/^\/_rpc\/(\w+)$/);
  if (m && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const fn = m[1];
      try {
        if (fn.endsWith('_') || typeof g.ctx[fn] !== 'function') throw new Error('Script function not found: ' + fn);
        const value = g.ctx[fn](...JSON.parse(body));
        send(200, 'application/json', JSON.stringify({ value: JSON.parse(JSON.stringify(value ?? null)) }));
      } catch (e) { send(200, 'application/json', JSON.stringify({ error: e.message })); }
    });
    return;
  }
  send(404, 'text/plain', 'not found');
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 8766;
  server.listen(port, () => console.log(`dev server on http://localhost:${port}/ (organizer code: ${CODE})`));
}
module.exports = { server, ctl, gas: g, CODE };
