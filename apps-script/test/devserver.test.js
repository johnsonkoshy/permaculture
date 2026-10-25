/* The dev server's switches for a slow or failing Sheet (test/dev-server.js). Build first: python3 build.py */
const test = require('node:test');
const assert = require('node:assert/strict');

test('dev server: /_ctl slows /_api calls and fails the ones named with an HTML page; one call can carry its own', async t => {
  const { server } = require('./dev-server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (fn, args = [], q = '') => fetch(base + '/_api' + q, { method: 'POST', body: JSON.stringify({ fn, args }) });
  const ctl = q => fetch(base + '/_ctl' + q).then(r => r.json());

  let r = await call('getPublic');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.ok(Array.isArray((await r.json()).value.events));
  assert.deepEqual(await ctl(''), { latency: 0, fail: '' });

  assert.deepEqual(await ctl('?latency=250&fail=saveEvent,signIn'), { latency: 250, fail: 'saveEvent,signIn' });
  let t0 = Date.now();
  r = await call('saveEvent', ['nope', {}]);
  assert.ok(Date.now() - t0 >= 240, 'slowed down');
  assert.equal(r.status, 502);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(await r.text(), /^<!DOCTYPE html>/, 'an HTML page, like Apps Script sends when it falls over');
  t0 = Date.now();
  r = await call('getPublic', [], '?latency=0');
  assert.ok(Date.now() - t0 < 240, 'one call can skip the wait');
  assert.equal(r.status, 200);
  r = await call('signIn', ['nope'], '?fail=');
  assert.deepEqual(await r.json(), { error: "That organizer code isn't right." }, 'one call can skip the failure');

  assert.deepEqual(await ctl('?latency=0&fail='), { latency: 0, fail: '' });
  r = await call('saveEvent', ['nope', {}]);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { error: "That organizer code isn't right." }, 'back to normal');

  const html = await (await fetch(base + '/site')).text();
  assert.ok(html.includes(`"${base}/_api"`), 'the page calls this server');
  assert.ok(!/_ctl|latency=/.test(html), 'the page knows nothing of the switches');
});
