/* Make inline scripts survive Apps Script's HtmlService.

   HtmlService strips "//" to the end of the line as a comment. It respects
   '...' and "..." strings but not `template literals`, so a URL or base64
   inside a template gets cut off and the page dies with a syntax error.
   This removes real comments and writes every "//" inside a string,
   template or regex as "/\/", which means the same thing.

   Usage: node gas-safe.js file.html   (rewrites the file in place) */
const fs = require('fs');
const vm = require('vm');
const acorn = require('acorn');

function safeJs(js) {
  const edits = [];
  const onComment = (block, text, start, end) => edits.push([start, end, '']);
  for (const t of acorn.tokenizer(js, { ecmaVersion: 'latest', onComment })) {
    const kind = t.type.label;
    if (kind === 'string' || kind === 'template' || kind === 'regexp') {
      const raw = js.slice(t.start, t.end);
      if (raw.includes('//')) edits.push([t.start, t.end, raw.replace(/\/\//g, '/\\/')]);
    }
  }
  edits.sort((a, b) => b[0] - a[0]);
  for (const [s, e, rep] of edits) js = js.slice(0, s) + rep + js.slice(e);
  return js;
}

/* What HtmlService does to "//", as far as we've seen. */
function googleStrip(js) {
  return js.split('\n').map(line => {
    let q = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = ''; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

if (require.main === module) {
  const file = process.argv[2];
  let n = 0;
  const html = fs.readFileSync(file, 'utf8').replace(/<script>([\s\S]*?)<\/script>/g, (m, js) => {
    const out = safeJs(js);
    const left = out.indexOf('//');
    if (left >= 0) throw new Error('gas-safe: "//" left in script ' + (n + 1) + ': ' + out.slice(left - 60, left + 40));
    new vm.Script(out, { filename: 'page-script-' + (++n) });            // still valid JS
    new vm.Script(googleStrip(out), { filename: 'after-google-' + n });  // and still valid after Google's pass
    return '<script>' + out + '</script>';
  });
  fs.writeFileSync(file, html);
  console.log(`gas-safe: ${n} script(s) ok`);
}

module.exports = { safeJs, googleStrip };
