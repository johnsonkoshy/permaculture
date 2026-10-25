# EBPG Posting Helper

A Chrome extension for East Bay Permaculture Guild organizers. In the Event Hub, choose **Open & fill** next to Partiful, Luma, Meetup, Facebook or Hylo. The helper opens that site in a new tab and fills in the event's title, date, time, place, description and image. You check everything and click Publish yourself. The helper never publishes anything.

Partiful, Luma and Meetup have no free way to post from code, so this does the typing for you in your own browser, where you're already signed in.

## Install

1. Get the folder: either this `chrome-extension` folder, or `ebpg-posting-helper.zip` unzipped (double-click it). The Event Hub has the zip at https://ebpg-event-hub.netlify.app/ebpg-posting-helper.zip: in an event's Outreach list, click **Fill forms automatically with the Posting Helper** for the download and these steps.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder (the one with `manifest.json` in it).
5. Pin it: click the puzzle piece in the toolbar, then the pin next to **EBPG Posting Helper**.

The Options page opens the first time. You need Chrome 116 or newer on a computer.

To update, replace the folder with the new one and click the reload arrow on the helper's card in `chrome://extensions`. Then reload any Event Hub tab you had open.

## Set the group links (once)

Partiful and Luma open by themselves. For Meetup, Facebook and Hylo, the helper opens the Guild's group, so it needs the links:

1. Right-click the helper's icon and choose **Options** (or use the Options button in its popup).
2. Paste the **Meetup group URL**, **Facebook group URL** and **Hylo group URL**.
3. Click **Save links**.

The links must be on meetup.com, facebook.com and hylo.com. If you paste the link of the group's own "Create event" page instead, the helper lands right on the form. If a link is missing when you click Open & fill, the helper opens Options with a note and the Event Hub tells you what to add.

## How it works with the Event Hub

1. In the Event Hub, open an event's posts and choose **Open & fill** next to a site. (The Hub only shows that button when the helper is installed.)
2. The helper saves the event in your browser and opens the site in a new tab next to the Hub.
3. When the form loads, the helper fills every box it recognizes and puts the event image into the form's own upload box if it has one. (It never uses other uploaders on the page, such as a cover photo or profile picture.)
4. A small panel appears in the corner: "EBPG Posting Helper filled N fields. Review everything, then publish." It lists every field with a **Copy** button, marks which ones were filled, and has **Fill again** and **Dismiss**.
5. You check the form, fix anything, and publish on the site. Then go back to the Hub and mark the post as posted.

For **Instagram** there's nothing to fill: the helper opens its side panel with the caption and the image, ready to copy and download.

The toolbar **popup** shows which event is loaded and has **Fill this tab**, **Open side panel** and **Options**. The **side panel** shows the whole event with Copy buttons, the image with a Download button, and a button to open and fill each site again.

## What's automatic and what you review

| The helper does this | You do this |
|---|---|
| Opens the right site in a new tab | Sign in to the site if it asks |
| Fills the title, date, start and end time, place, description and image wherever it finds the boxes | Check every field, especially the date, time and place |
| Types the address into location boxes | Pick the matching place from the site's suggestion list |
| Shows a Copy button for every field, filled or not | Paste anything it couldn't fill (custom date pickers, cover photo croppers) |
| Waits for forms that load late (about 20 seconds) | Click **Fill again** if you opened the form later |
| **Never** clicks Publish, Post, Create or Submit | Click Publish |

It only fills the tab it opened for you (or a tab you ask it to fill with **Fill this tab**), and only for 30 minutes after you clicked Open & fill. Opening a site again from the side panel gives you another 30 minutes. It never types over words you've already written unless you click **Fill again**.

It fills each tab by itself **once**. If you open another form in that same tab (a new event after publishing, or a fresh post box), the panel shows up but waits, so nothing gets posted twice by accident. Click **Fill again** if you do want that page filled.

## Which parts are guesses

Nobody could sign in to the real sites while building this, so the way it finds each box is a **heuristic**, not a fixed selector. It looks at each box's label, placeholder, aria-label, name and the text just before it, and matches words like:

- **Title:** title, event name, "Untitled event", "Your event's name"
- **Date and time:** date, start, end, time, plus date pickers (`type="date"`, `type="time"`, `datetime-local`) and placeholders like MM/DD/YYYY or hh:mm. Unlabeled pairs are read as start then end.
- **Place:** location, where, venue, place, address
- **Description:** description, details, about, "What are the details?"
- **Post box** (Facebook and Hylo groups): "Create a public post", "Write something", "What's on your mind"

Each site was checked against a hand-made copy of its form in `tests/fixtures/`, using jsdom. It has not yet been tried on the live sites. What to expect on each site:

| Site | Expected to fill | Expect to copy and paste |
|---|---|---|
| Partiful | Title, place, description, cover image | Date and time (Partiful uses a custom picker) |
| Luma | Title, and date, time, place and description where they are text boxes | Anything behind a pop-up picker |
| Meetup | Title, date, times, venue search text, description, photo | Picking the venue from Meetup's list |
| Facebook group | The group's post box (full text) | For an event: click Create event, then Fill again |
| Hylo | Title, start and end, place, description | Choosing the post type (Event) first |

When a site changes its page, the panel's Copy buttons still work. Fixes for a changed form go in `src/filler.js` (the `RULES` list), with a new fixture and test.

## Privacy

- Everything stays in your browser. The helper has no server and makes no network requests.
- The event you send is kept in Chrome's extension storage on this computer until you send another one or click **Forget this event** (side panel) or **Forget the saved event** (Options).
- The group links are saved in your Chrome profile (Chrome syncs them if you use Chrome sync).
- It asks for two permissions: `storage` (to keep the event and links) and `sidePanel`. It runs only on the Event Hub (ebpg-event-hub.netlify.app and the local test server), partiful.com, lu.ma, luma.com, meetup.com, facebook.com and hylo.com. Chrome lists those sites when you install it.

## Known limits

- Desktop Chrome 116 or newer. It should also work in Edge and Brave, but that hasn't been tried.
- Custom pickers (dates, times, places, cover croppers) can't be typed into; use the Copy buttons.
- If a site blocks copying, the panel shows that field's whole text in a box, already selected. Press Ctrl+C (Command+C on a Mac) to copy it.
- If the site asks you to sign in first, sign in. When the form loads in that same tab, the helper fills it. If it doesn't, click **Fill this tab** in the popup.
- After about 20 seconds the helper stops watching the page. Click **Fill again** if you opened the form later.
- Facebook fills the group's post box. Facebook events need you to click Create event first.
- Images up to 5 MB, as PNG, JPEG, WebP or GIF. Any other image is left out (the rest of the event is still filled, and the Event Hub is told why), so add it on the site yourself. Text up to 20,000 characters; longer text is cut.
- After you update or reload the helper, reload the Event Hub tab before using Open & fill again.

## For developers

```
chrome-extension/
  manifest.json        Manifest V3. Permissions: storage, sidePanel.
  src/shared.js        Constants, the message check (validateHubMessage, sanitizeDraft), formatters
  src/hub-bridge.js    Content script on the Event Hub (document_start)
  src/background.js    Service worker: opens sites, remembers which tab is for which site
  src/filler.js        Field finding and filling heuristics (no clicks, no submits)
  src/panel.js         The floating panel (shadow DOM; text only via textContent)
  src/site.js          Content script on the target sites: claim the draft, fill, watch, panel
  pages/               Popup, side panel and options page (shared ui.css, common.js)
  icons/               16, 32, 48 and 128 px PNGs (made by tools/make-icons.js)
  tools/make-icons.js  Draws the icons; no dependencies
  tools/build-zip.js   Builds dist/ebpg-posting-helper.zip; no dependencies
  tests/               node --test with jsdom, plus HTML fixtures of each site's form
```

Plain JavaScript, no build step and no remote code. Each `src` file works as a Chrome script and as a Node module, so the tests run the real code.

### Protocol with the Event Hub

1. **Detecting the helper.** The hub content script runs at `document_start` on `https://ebpg-event-hub.netlify.app/*` and `http://localhost:8766/*` and sets:
   ```js
   document.documentElement.dataset.ebpgPoster = '1.0.0'   // the extension version
   ```
2. **Asking for a fill.** The page sends:
   ```js
   window.postMessage({
     source: 'ebpg-hub', type: 'fill',
     channel,   // 'partiful' | 'luma' | 'meetup' | 'facebook' | 'hylo' | 'instagram'
     draft: { title, date /* 'YYYY-MM-DD' */, start /* 'HH:MM' */, end /* 'HH:MM' */, place, address,
              description, text, eventUrl, imageDataUrl /* optional 'data:image/png;base64,...' */ }
   }, location.origin);
   ```
3. **Checks.** The content script accepts only `event.source === window`, `event.origin === location.origin` (one of the hub origins) and `data.source === 'ebpg-hub'`, `type === 'fill'`. Title is required. Text fields are cut to 20,000 characters, title and place to a few hundred; bad dates, times and non-http links are dropped. An image that is not a PNG, JPEG, WebP or GIF data URL of at most 5 MB is left out, and the rest still goes through. A repeat of the same request within 1.5 seconds, or while the first is still being handled (a double click), is ignored with no reply of its own: the first request's reply answers it. A request for a different site within those 1.5 seconds gets an error.
4. **Saving.** `chrome.storage.local` key `draft`: `{ channel, timestamp, origin, draft }`. If it does not fit with the image, it is saved without the image. Later opens from the side panel add `openedAt` and `openedFor`.
5. **Reply** on the same window, to `location.origin`:
   ```js
   { source: 'ebpg-poster', type: 'opened', channel }
   { source: 'ebpg-poster', type: 'opened', channel, imageDropped: true, note }   // opened, but the image was left out; note is a sentence to show people
   { source: 'ebpg-poster', type: 'error', channel, message }   // message is a sentence to show people
   ```
   The error comes back for a missing group link (Options opens), an unknown channel, a missing title, storage trouble even without the image, or a helper that was reloaded since the page loaded.

Inside the extension: the service worker opens the target (`https://partiful.com/create`, `https://lu.ma/create`, or the saved group link) and records `{ tabId: { channel, at } }` in `chrome.storage.session`. On each page load the site content script first reads `draft` from `chrome.storage.local`; if there is none, or it is over 30 minutes old, it stops there (no page listeners, no message to the service worker). Otherwise it asks for the draft with `{ type: 'claim' }`, and gets it only if its tab is that tab, its site matches the channel and the draft is under 30 minutes old. After its first fill it sends `{ type: 'used' }`, and the service worker adds `used: true` to that tab's record. Later claims from the tab come back with `used: true`: the panel shows, but nothing is filled until **Fill again** or **Fill this tab** (which arms the tab afresh).

### Tests

The tests need Node 22.22.2 or newer (Node 22, 24, or 26 and up), because jsdom requires it. Check with `node --version`.

```
cd chrome-extension
npm install      # jsdom, for the tests only
npm test
```

They cover the field matching and filling on fixtures of each site (React-style controlled inputs, labels, rich-text editors, date and time inputs, a sign-in page that must not be filled, an image uploader outside the form that must stay empty), the hub message checks, the service worker's tab rules (including one automatic fill per tab), the panel, the popup, side panel and options pages, the manifest and the zip.

### Building the zip

```
node tools/build-zip.js     # or: npm run zip
```

This writes `dist/ebpg-posting-helper.zip` with only `manifest.json`, `README.md`, `src/`, `pages/` and `icons/`. It needs nothing installed beyond Node, and the same files always give the same zip. `dist/` is not committed. `apps-script/build.py` runs this too and copies the zip into `apps-script/site/`, so the Netlify site serves it at `/ebpg-posting-helper.zip`.

### Icons

```
node tools/make-icons.js    # or: npm run icons
```

Redraws `icons/icon-*.png` (the Guild's sprout mark in fern green, sage and cream). Commit the PNGs.
