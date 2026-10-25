/* EBPG Posting Helper: options page. Saves the Guild's Meetup, Facebook and Hylo group links. */
(function () {
  'use strict';
  const shared = globalThis.EBPG.shared;
  const P = globalThis.EBPGPage;
  const $ = id => document.getElementById(id);
  const FIELDS = [['meetup', 'meetupUrl'], ['facebook', 'facebookUrl'], ['hylo', 'hyloUrl']];
  const SITE = { meetup: 'meetup.com', facebook: 'facebook.com', hylo: 'hylo.com' };

  async function load() {
    const saved = await chrome.storage.sync.get(FIELDS.map(f => f[1]));
    FIELDS.forEach(([, key]) => { $(key).value = saved[key] || ''; });
    const { notice } = await chrome.storage.local.get('notice');
    if (notice && Date.now() - notice.at < 10 * 60 * 1000 && shared.CHANNEL_INFO[notice.channel]) {
      const name = shared.CHANNEL_INFO[notice.channel].name;
      const n = $('notice');
      n.textContent = `Add the Guild's ${name} group link below and save. Then go back to the Event Hub and choose Open & fill again.`;
      n.hidden = false;
      const key = (FIELDS.find(f => f[0] === notice.channel) || [])[1];
      if (key) $(key).focus();
    }
    if (notice) chrome.storage.local.remove('notice');
  }

  function showError(key, text) {
    const input = $(key), err = $(key + '-err');
    input.setAttribute('aria-invalid', text ? 'true' : 'false');
    err.textContent = text || '';
    err.hidden = !text;
  }

  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    const out = {};
    let firstBad = null;
    FIELDS.forEach(([channel, key]) => {
      const raw = $(key).value.trim();
      if (!raw) { out[key] = ''; showError(key, ''); return; }
      const url = shared.normalizeGroupUrl(channel, raw);
      if (!url) {
        showError(key, `This needs to be a link on ${SITE[channel]}.`);
        if (!firstBad) firstBad = key;
        return;
      }
      out[key] = url;
      $(key).value = url;
      showError(key, '');
    });
    if (firstBad) { $(firstBad).focus(); P.say($('status'), 'Check the highlighted link.', true); return; }
    await chrome.storage.sync.set(out);
    $('notice').hidden = true;
    P.say($('status'), 'Saved.');
  });

  $('forget').addEventListener('click', async () => {
    await chrome.storage.local.remove('draft');
    P.say($('forget-status'), 'Done. No event is saved in this browser now.');
  });

  load();
})();
