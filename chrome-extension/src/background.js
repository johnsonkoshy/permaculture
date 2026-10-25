/*
 * EBPG Posting Helper: service worker. Opens the target site in a new tab, remembers which
 * tab it opened for which site (chrome.storage.session, cleared when Chrome closes), and
 * hands the draft only to the content script in that tab. Each tab fills by itself once;
 * after that the panel offers Fill again.
 */
/* global importScripts */
if (typeof importScripts === 'function' && typeof module === 'undefined') importScripts('shared.js');

(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./shared.js') : root.EBPG.shared);
  if (isNode) module.exports = api;
  else api.createBackground(root.chrome).register();
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  'use strict';

  function createBackground(chrome, opts) {
    const now = (opts && opts.now) || (() => Date.now());
    let pending = Promise.resolve();

    const nameOf = channel => (shared.CHANNEL_INFO[channel] || {}).name || 'that site';
    const extensionBase = () => chrome.runtime.getURL('');

    function senderOrigin(sender) {
      if (sender.origin) return sender.origin;
      try { return new URL(sender.url).origin; } catch (e) { return ''; }
    }
    const isOurs = sender => !!sender && sender.id === chrome.runtime.id;
    const fromHub = sender => isOurs(sender) && !!sender.tab && shared.HUB_ORIGINS.includes(senderOrigin(sender));
    const fromExtensionPage = sender => isOurs(sender) && typeof sender.url === 'string' && sender.url.startsWith(extensionBase());
    function siteChannel(sender) {
      try { return shared.channelForHost(new URL(sender.url).hostname); } catch (e) { return null; }
    }

    async function getArmed() {
      const r = await chrome.storage.session.get('armed');
      return (r && r.armed) || {};
    }
    async function arm(tabId, channel) {
      const armed = await getArmed();
      armed[tabId] = { channel, at: now() };
      await chrome.storage.session.set({ armed });
    }
    async function disarm(tabId) {
      const armed = await getArmed();
      if (!(tabId in armed)) return;
      delete armed[tabId];
      await chrome.storage.session.set({ armed });
    }
    async function getDraft() {
      const r = await chrome.storage.local.get('draft');
      return (r && r.draft) || null;
    }
    // Opening a site again from the side panel or popup keeps the draft fresh for 30 more minutes.
    async function touchDraft(channel) {
      const rec = await getDraft();
      if (!rec) return null;
      rec.openedAt = now();
      rec.openedFor = channel;
      await chrome.storage.local.set({ draft: rec });
      return rec;
    }

    async function targetUrl(channel) {
      const info = shared.CHANNEL_INFO[channel];
      if (!info) return null;
      if (info.url) return info.url;
      const saved = await chrome.storage.sync.get(info.setting);
      return shared.normalizeGroupUrl(channel, saved && saved[info.setting]);
    }

    async function openSite(channel, fromTab) {
      const url = await targetUrl(channel);
      if (!url) {
        await chrome.storage.local.set({ notice: { channel, at: now() } });
        await chrome.runtime.openOptionsPage();
        return { ok: false, error: `Add the Guild's ${nameOf(channel)} group link in the Posting Helper options, then try again. The options page is open in a new tab.` };
      }
      const props = { url, active: true };
      if (fromTab && typeof fromTab.id === 'number') {
        props.openerTabId = fromTab.id;
        if (typeof fromTab.index === 'number') props.index = fromTab.index + 1;
      }
      const tab = await chrome.tabs.create(props);
      await arm(tab.id, channel);
      return { ok: true, channel, tabId: tab.id };
    }

    // Instagram has nothing to fill: show the caption and image in the side panel.
    // sidePanel.open() must run straight away, while Chrome still counts the click.
    function openInstagram(fromTab) {
      let opened;
      try {
        opened = Promise.resolve(chrome.sidePanel.open(fromTab && typeof fromTab.windowId === 'number' ? { windowId: fromTab.windowId } : {}));
      } catch (e) {
        opened = Promise.reject(e);
      }
      return opened.then(
        () => ({ ok: true, channel: 'instagram', where: 'side-panel' }),
        async () => {
          const props = { url: chrome.runtime.getURL('pages/sidepanel.html?view=tab'), active: true };
          if (fromTab && typeof fromTab.index === 'number') props.index = fromTab.index + 1;
          await chrome.tabs.create(props);
          return { ok: true, channel: 'instagram', where: 'tab' };
        });
    }

    async function claim(sender) {
      await pending;
      const tabId = sender.tab && sender.tab.id;
      const channel = siteChannel(sender);
      if (typeof tabId !== 'number' || !channel) return { draft: null };
      const armed = await getArmed();
      const a = armed[tabId];
      if (!a || a.channel !== channel) return { draft: null };
      const rec = await getDraft();
      if (!shared.isFresh(rec, now())) return { draft: null };
      // After the first fill in this tab, later pages get the panel but are not filled on
      // their own (a new composer after posting must not get the same event again).
      return { draft: rec.draft, channel, used: !!a.used };
    }

    // The tab's content script filled a form: no more automatic fills in this tab until it
    // is armed again (Open & fill, opening the site from the side panel, or Fill this tab).
    async function markUsed(sender) {
      await pending;
      const tabId = sender.tab && sender.tab.id;
      const channel = siteChannel(sender);
      const armed = await getArmed();
      const a = armed[tabId];
      if (typeof tabId !== 'number' || !a || a.channel !== channel) return false;
      if (!a.used) {
        a.used = true;
        await chrome.storage.session.set({ armed });
      }
      return true;
    }

    async function fillTab(tabId) {
      if (typeof tabId !== 'number') return { ok: false, error: 'Open the site you want to fill first.' };
      let hello = null;
      try { hello = await chrome.tabs.sendMessage(tabId, { type: 'ebpg-hello' }); } catch (e) { hello = null; }
      if (!hello || !hello.channel) return { ok: false, error: 'This tab is not one the helper can fill. Open Partiful, Luma, Meetup, Facebook or Hylo first.' };
      if (!(await getDraft())) return { ok: false, error: 'No event yet. Send one from the Event Hub first.' };
      await touchDraft(hello.channel);
      await arm(tabId, hello.channel);
      let res = null;
      try { res = await chrome.tabs.sendMessage(tabId, { type: 'ebpg-fill-now' }); } catch (e) { res = null; }
      if (res && res.ok) return { ok: true, channel: hello.channel, count: res.count || 0 };
      return { ok: false, error: 'The helper could not fill this tab. Reload the page and try again.' };
    }

    function handle(msg, sender) {
      if (!msg || typeof msg !== 'object' || !isOurs(sender)) return Promise.resolve({ ok: false, error: 'Not allowed.' });
      switch (msg.type) {
        case 'open': {
          if (!fromHub(sender)) return Promise.resolve({ ok: false, error: 'Not allowed.' });
          if (!shared.CHANNELS.includes(msg.channel)) return Promise.resolve({ ok: false, error: 'The helper does not know that site yet.' });
          const p = msg.channel === 'instagram' ? openInstagram(sender.tab) : openSite(msg.channel, sender.tab);
          pending = p.catch(() => null);
          return p;
        }
        case 'open-target': {
          if (!fromExtensionPage(sender)) return Promise.resolve({ ok: false, error: 'Not allowed.' });
          if (!shared.CHANNELS.includes(msg.channel)) return Promise.resolve({ ok: false, error: 'The helper does not know that site yet.' });
          const p = (async () => {
            if (msg.channel === 'instagram') {
              await chrome.tabs.create({ url: shared.CHANNEL_INFO.instagram.url, active: true });
              return { ok: true, channel: 'instagram' };
            }
            if (!(await getDraft())) return { ok: false, error: 'No event yet. Send one from the Event Hub first.' };
            await touchDraft(msg.channel);
            return openSite(msg.channel, null);
          })();
          pending = p.catch(() => null);
          return p;
        }
        case 'fill-tab':
          if (!fromExtensionPage(sender)) return Promise.resolve({ ok: false, error: 'Not allowed.' });
          return fillTab(msg.tabId);
        case 'claim':
          if (!sender.tab) return Promise.resolve({ draft: null });
          return claim(sender);
        case 'used':
          if (!sender.tab) return Promise.resolve({ ok: false });
          return markUsed(sender).then(ok => ({ ok }));
        case 'disarm':
          if (!sender.tab) return Promise.resolve({ ok: false });
          return disarm(sender.tab.id).then(() => ({ ok: true }));
        default:
          return Promise.resolve({ ok: false, error: 'Unknown request.' });
      }
    }

    function register() {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        handle(msg, sender).then(sendResponse, err => {
          console.error('EBPG Posting Helper:', err);
          sendResponse({ ok: false, error: 'Something went wrong in the Posting Helper. Try again.' });
        });
        return true;
      });
      chrome.tabs.onRemoved.addListener(tabId => { disarm(tabId).catch(() => null); });
      if (chrome.runtime.onInstalled) {
        chrome.runtime.onInstalled.addListener(details => {
          if (details && details.reason === 'install') chrome.runtime.openOptionsPage();
        });
      }
    }

    return { register, handle, claim, markUsed, arm, disarm, targetUrl, openSite, fillTab };
  }

  return { createBackground };
});
