/* The dev server's switches for a slow or failing Sheet (test/dev-server.js). Build first: python3 build.py */
const test = require('node:test');
const assert = require('node:assert/strict');

test('dev server: /_ctl slows /_api calls and fails the ones named with an HTML page; one call can carry its own', async t => {
  const { server, CODE, gas } = require('./dev-server');
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

  // organizers sign in with the dev Sheet's code, and are told test mode is on and who gets the emails
  assert.equal(CODE, 'garden-dev-1234');
  const st = (await (await call('signIn', [CODE])).json()).value;
  assert.deepEqual([st.testMode, st.owner, st.quota], [true, 'owner@example.com', 100]);
  // /_ctl?quota= sets the emails left today: at 20, a welcome email waits
  await ctl('?quota=20');
  assert.equal(gas.mailbox.quota, 20);
  const sent = gas.mail.length;
  assert.equal((await (await call('addVolunteer', [{ name: 'Sam Lee', contact: 'sam@example.org', help: [], note: '' }])).json()).value, true);
  assert.equal(gas.mail.length, sent, 'held back');
  assert.ok(gas.tab('Reminders').some(r => r[3] === 'skipped (quota): Welcome to the East Bay Permaculture Guild'));
  await ctl('?quota=100');
  // ?fail=addVolunteer: the volunteer form's send gets the error page; once cleared, Try again (the same id) is kept once
  const join = { name: 'Maya Ortiz', email: 'maya@example.org', help: ['Garden work days'], id: 'devserver-join-1', elapsed: 8000 };
  await ctl('?fail=addVolunteer');
  r = await call('addVolunteer', [join]);
  assert.equal(r.status, 502);
  await ctl('?fail=');
  const rows = () => gas.tab('Volunteers').filter(x => x[1] === 'Maya Ortiz').length;
  assert.equal((await (await call('addVolunteer', [join])).json()).value, true);
  assert.equal((await (await call('addVolunteer', [join])).json()).value, true);
  assert.equal(rows(), 1);

  const html = await (await fetch(base + '/site')).text();
  assert.ok(html.includes(`"${base}/_api"`), 'the page calls this server');
  assert.ok(!/_ctl|latency=/.test(html), 'the page knows nothing of the switches');

  // the Posting Helper's install zip, where the Outreach list's Download link points
  r = await fetch(base + '/ebpg-posting-helper.zip');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString('hex'), '504b0304', 'a zip file');
});
