/* EBPG Posting Helper: side panel. Shows the current event with Copy buttons, the image
 * with a Download button, and buttons that open each site and fill it. */
(function () {
  'use strict';
  const shared = globalThis.EBPG.shared;
  const P = globalThis.EBPGPage;
  const $ = id => document.getElementById(id);
  const status = $('status');
  const asTab = new URLSearchParams(location.search).get('view') === 'tab';
  if (asTab) document.body.classList.add('as-tab');

  const TARGETS = ['partiful', 'luma', 'meetup', 'facebook', 'hylo', 'instagram'];
  const targets = $('targets');
  TARGETS.forEach(ch => {
    const b = P.iconButton('out', shared.CHANNEL_INFO[ch].name);
    b.setAttribute('aria-label', `Open ${shared.CHANNEL_INFO[ch].name}${ch === 'instagram' ? '' : ' and fill it'}`);
    b.addEventListener('click', async () => {
      P.say(status, `Opening ${shared.CHANNEL_INFO[ch].name}…`);
      const res = await P.send({ type: 'open-target', channel: ch });
      if (res && res.ok) P.say(status, ch === 'instagram' ? 'Instagram is open. Paste the caption and add the image there.' : `${shared.CHANNEL_INFO[ch].name} is open. Review the form there, then publish.`);
      else P.say(status, (res && res.error) || 'That did not work. Try again.', true);
    });
    targets.appendChild(b);
  });

  const fillBtn = $('fill-tab');
  fillBtn.innerHTML = P.ICONS.fill;
  fillBtn.append('Fill the current tab');
  if (asTab) $('fill-wrap').hidden = true;
  fillBtn.addEventListener('click', async () => {
    const tab = await P.activeTab();
    const res = await P.send({ type: 'fill-tab', tabId: tab && tab.id });
    if (res && res.ok) P.say(status, res.count ? `Filled ${res.count} ${res.count === 1 ? 'field' : 'fields'}. Review everything, then publish.` : 'The form was not found on that page. Use the Copy buttons instead.');
    else P.say(status, (res && res.error) || 'That did not work. Try again.', true);
  });

  $('forget').addEventListener('click', async () => {
    await chrome.storage.local.remove('draft');
    P.say(status, 'The event was removed from this browser.');
  });
  $('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

  async function render() {
    const rec = await P.getDraft();
    const has = !!(rec && rec.draft);
    $('empty').hidden = has;
    $('draft').hidden = !has;
    targets.querySelectorAll('button').forEach(b => { b.disabled = !has; });
    fillBtn.disabled = !has;
    if (!has) return;
    const d = rec.draft;
    const forName = (shared.CHANNEL_INFO[rec.openedFor || rec.channel] || {}).name;
    const t = Math.max(rec.timestamp || 0, rec.openedAt || 0);
    $('d-meta').textContent = `From the Event Hub${forName ? ' for ' + forName : ''} · ${shared.ago(rec.timestamp || t, Date.now())}`;
    $('d-title').textContent = d.title;
    $('d-when').textContent = P.whenLine(d);
    $('d-ig').hidden = rec.channel !== 'instagram';
    const url = P.imageUrl(d.imageDataUrl);
    $('d-img').hidden = !url;
    if (url) {
      $('d-img-el').src = url;
      const dl = $('d-dl');
      dl.href = url;
      dl.setAttribute('download', shared.imageFileName(d));
      dl.innerHTML = P.ICONS.download;
      dl.append('Download image');
    }
    P.renderRows($('d-rows'), d, status);
  }

  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.draft) render(); });
  render();
})();
