/* Serve the built page with a fake google.script.run that calls Code.js
   running on the mock. Run: node test/dev-server.js, open http://localhost:8766/
   GET /site serves the Netlify build, calling the mock through POST /_api (doPost).
   GET /_state dumps the mock Sheet and the emails it "sent". */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeGas } = require('./gas-mock');

const g = makeGas({ page: path.join(__dirname, '..', 'dist', 'index.html') });
const SHIM = `<script>(() => {
  const runner = (ok, no) => new Proxy({}, { get: (_, fn) => {
    if (fn === 'withSuccessHandler') return f => runner(f, no);
    if (fn === 'withFailureHandler') return f => runner(ok, f);
    return (...args) => fetch('/_rpc/' + fn, { method: 'POST', body: JSON.stringify(args) }).then(r => r.json())
      .then(r => r.error ? no && no(new Error(r.error)) : ok && ok(r.value));
  } });
  window.google = { script: { run: runner() } };
})();</script>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  if (url.pathname === '/') {
    const out = g.ctx.doGet({ parameter: Object.fromEntries(url.searchParams) });
    return send(200, 'text/html; charset=utf-8', SHIM + out.content);
  }
  if (url.pathname === '/site') {
    const html = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8').replace(/https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec/, 'http://localhost:8766/_api');
    return send(200, 'text/html; charset=utf-8', html);
  }
  if (url.pathname === '/_api' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => send(200, 'application/json', g.ctx.doPost({ postData: { contents: body } }).content));
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
}).listen(8766, () => console.log('dev server on http://localhost:8766/'));
