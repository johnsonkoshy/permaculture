/* EBPG Posting Helper: toolbar popup. Says whether an event is loaded and links to the
 * side panel and options. */
(function () {
  'use strict';
  const shared = globalThis.EBPG.shared;
  const P = globalThis.EBPGPage;
  const $ = id => document.getElementById(id);
  const status = $('status');

  const fill = $('fill'), panel = $('panel'), opts = $('opts');
  fill.innerHTML = P.ICONS.fill; fill.append('Fill this tab');
  panel.innerHTML = P.ICONS.panel; panel.append('Open side panel');
  opts.innerHTML = P.ICONS.gear; opts.append('Options');

  async function render() {
    const rec = await P.getDraft();
    const box = $('state');
    box.replaceChildren();
    if (!rec || !rec.draft) {
      const b = document.createElement('b');
      b.textContent = 'No event loaded';
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'In the Event Hub, choose Open & fill next to a site. The event will show up here.';
      box.append(b, p);
      fill.disabled = true;
      return;
    }
    const d = rec.draft;
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    const forName = (shared.CHANNEL_INFO[rec.openedFor || rec.channel] || {}).name;
    eyebrow.textContent = `Event loaded${forName ? ' for ' + forName : ''}`;
    const b = document.createElement('b');
    b.textContent = d.title;
    const when = document.createElement('p');
    when.className = 'muted';
    when.textContent = P.whenLine(d);
    const age = document.createElement('p');
    age.className = 'muted';
    age.style.fontSize = '13px';
    age.textContent = `Sent from the Event Hub ${shared.ago(rec.timestamp, Date.now())}.` +
      (shared.isFresh(rec, Date.now()) ? '' : ' Open a site from the side panel to fill it again.');
    box.append(eyebrow, b, when, age);
    fill.disabled = false;
  }

  fill.addEventListener('click', async () => {
    const tab = await P.activeTab();
    const res = await P.send({ type: 'fill-tab', tabId: tab && tab.id });
    if (res && res.ok) P.say(status, res.count ? `Filled ${res.count} ${res.count === 1 ? 'field' : 'fields'}. Review everything, then publish.` : 'The form was not found on this page. Use the Copy buttons on the page instead.');
    else P.say(status, (res && res.error) || 'That did not work. Try again.', true);
  });

  panel.addEventListener('click', async () => {
    try {
      const tab = await P.activeTab();
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    } catch (e) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('pages/sidepanel.html?view=tab') });
      window.close();
    }
  });

  opts.addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });

  render();
})();
