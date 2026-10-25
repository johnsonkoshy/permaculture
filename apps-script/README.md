# EBPG Event Hub: live version (Google Sheets + Apps Script)

The Event Hub prototype, now saving to a real Google Sheet. The page is hosted on Netlify, and the Sheet and Apps Script do the saving, emails and reminders. Both are owned by gistparent@gmail.com for now.

| What | Link |
|---|---|
| The Sheet (the database) | https://drive.google.com/open?id=1zAE_ePxb1gFDo5r34mUVk82CBh5X1p3-wztvsqCx8HI |
| Script editor | https://script.google.com/d/1evyOeS39k_5SJVD2FcJ0j1LVqHtUj87COZAlYdB_yXI80AEn5UPtuSC4/edit |
| **The site (share this one)** | https://ebpg-event-hub.netlify.app |
| Apps Script web app (the API; also serves the old Google-hosted page) | https://script.google.com/macros/s/AKfycbxy4le3b-fRgH9BjhSZrcPf3TDcSgzMZ0sDnZEeRiZsCnPoX5jPVy6GU5DPtyoUjERf/exec |

## Morning: 5 minutes to turn it on

1. **Approve it once.** Open the script editor link and pick **setup** in the function menu at the top. Click **Run**, then **Review permissions**, and choose your account. Google will say *"Google hasn't verified this app"*. That's normal for a script you wrote yourself: click **Advanced → Go to EBPG Event Hub (unsafe) → Allow**. This sets up the Sheet tabs and the hourly reminder check. If the organizer code is blank (a new Sheet) or still the one the first version shipped with, setup makes a new one, writes it to the Settings tab and prints it in the Execution log under the code. Share it only with organizers.
2. **Open the site and sign in.** Go to https://ebpg-event-hub.netlify.app and you'll see the Guild's landing page. Click **Sign in**, type the organizer code (see the ORGANIZER_CODE row on the Settings tab), and pick your name. The first sign-in on an empty Sheet fills it with the Guild's six events from the OPC planning notes and the team's names, roles and permissions. Contacts start blank, the volunteer list starts empty, and Workday #7 and Community Meeting #2 are drafts: their posts wait for review and their tasks need someone. This happens only once. Afterwards `SEEDED` on the Settings tab says TRUE, so emptying a tab by hand never brings the starter events back.
3. **If the link still says "Access Denied":** in the script editor go to **Deploy → Manage deployments → ✏️**. Set *Execute as* to **Me** and *Who has access* to **Anyone**, then click **Deploy**. Or just tell Claude, and it will redeploy.

## Before the demo

1. On the Settings tab, set `REMINDERS` to **FALSE**, so nobody gets a reminder while you set up.
2. In the script editor, pick **resetStarterData** in the function menu and click **Run**. It empties the data tabs (Events, Bringing, Posts, Activity, Volunteers, Reminders, Team and Gardens). Headers and Settings stay. It also deletes real volunteer sign-ups, so copy any you want to keep first. It can't be run from the page.
3. Open the site and sign in once. That fills the Sheet with the starter events again.
4. Fill in the real contacts on the Team tab (email or phone). Until then the Team page shows "No contact yet".
5. Confirm the Workday #7 date and description with Jessie, and fix them in the app or the Sheet.
6. In Google Calendar, create an **EBPG Events** calendar and put its ID in `CALENDAR_ID` (Calendar settings → Integrate calendar → Calendar ID). Create a test Google Group and put its address in `GROUP_EMAIL`.
7. Set `REMINDERS` back to **TRUE**.

## How the pieces fit

- **Netlify** serves the page (`site/index.html`). It's fast, has no Google banner, and could use the Guild's own domain later.
- **The page** sends each save as a POST to the Apps Script web app (`doPost`). Only seven page functions can be called, and every organizer action checks the organizer code.
- **Apps Script** reads and writes the Sheet, sends email through Gmail and adds Calendar events. The hourly reminder trigger runs there too.
- **The old Google link** still works. Put `https://ebpg-event-hub.netlify.app` in `SITE_URL` on the Settings tab and it will send visitors to Netlify instead.
- **Netlify settings:** the site was created with Netlify's "visitor access: Netlify login" protection on. It was switched off so the public can open the page.

## What works

- **Landing page** for the public: upcoming events, a garden map and the volunteer sign-up. Sign-ups go to the **Volunteers** tab. The volunteer gets a welcome email and the lead organizer gets a "new volunteer" email.
- **Organizer sign-in** with the organizer code. You can change the code on the **Settings** tab at any time; it needs at least 8 characters, and a blank or shorter one lets nobody in ("The organizer code isn't set up yet. Ask the Sheet owner."). After 20 wrong codes in 10 minutes, every organizer call says "Too many tries. Wait 10 minutes and try again." until the 10 minutes are up, so the code can't be guessed. A page left open with the old code stops calling the Sheet as soon as it's turned down, keeps its unsaved changes and asks for the new code, so it never uses up those tries. The header shows who is signed in.
- **Test-mode banner:** while `TEST_MODE` is TRUE, every organizer page has a yellow note: "Test mode: every email goes only to *the owner*. Turn it off on the Settings tab when you're ready to go live.", with an **Open the Sheet** link. It goes away within two minutes of setting `TEST_MODE` to FALSE.
- **Saving you can see:** a note under the top bar (or under the event pop-up's own bar, while one is open) says *Saving…*, then *All changes saved*. If the Sheet doesn't answer (Apps Script can take a few seconds to wake up, or a phone loses signal), it says *Not saved* with a **Retry** button, retries on its own after 2, 5 and 15 seconds and then every minute (and right away when you come back to the tab or press Save again), and marks the event's tile *Not saved*. Saves of one event go out one at a time, newest last. "Saved" and "added" messages appear only once the Sheet has the change, and the browser asks before closing a tab with unsaved changes.
- **Staying current:** when you come back to the tab, and every 2 minutes while it's open, the page reads the Sheet again and says *Updated with the latest changes* if someone else changed something. Events with unsaved changes here, or being edited, are left alone.
- **Signing in:** the name you pick says *Signing in…* while the Sheet wakes up (the very first sign-in, which fills an empty Sheet, can take up to a minute). Tick **Remember this device for 30 days** to stay signed in on that phone or laptop; otherwise the code is forgotten when the tab closes. Sign out forgets it either way.
- **Help tab** for organizers: where the data lives (with a link to the Sheet), the organizer code, test mode, when reminders go out, hand edits, and who the lead organizer is.
- **Events:** creating, editing, the host and co-hosts, the timeline and "who's bringing what" all save to the Sheet in under a second.
- **Outreach review:** every post starts as a draft (*Draft · needs review*). Someone with **Approve & post** on the Team page clicks **Approve** (*Approved by Sky*); the text stays editable, and changing it sends it back to review. **Approve all drafts** approves every draft of an event at once. People without the permission see where each post stands, read-only, with who can approve it. The attention bar on the Events page says how many drafts wait for review and how many approved posts are ready, and **Review next** opens the soonest one.
- **Posting, once approved:**
  - **Google Group:** the **Post** button sends the email.
  - **Calendar:** the **Post** button adds the event.
  - **Post** says *Posting…* until the Sheet answers. The Sheet saves the event first, so the email and the Calendar entry always have the title, date, time and place on screen, even for an event created a moment ago. Only an approved post can go out, and only once: pressing Post again, or from a tab left open since before, says *Already posted* and sends nothing. The Posts row says posted only after it really went, and a save from an old tab never turns it back into a draft, or a draft back into posted. If the Sheet doesn't answer, nothing changes on the page.
  - **Test mode:** the row says *Test sent* (hover: *Test mode is on: this went only to the Sheet owner*). The email goes only to the owner, and Calendar entries go on the owner's own calendar with `[TEST] ` before the title. Once `TEST_MODE` is FALSE, a test-sent row offers **Post for real**; for the Calendar it takes the `[TEST]` entry off and adds the real one. Post for real goes out once too: pressed again, or from another tab, it says *Already posted*. If test mode is turned back on after a real post, **Update calendar** leaves the Guild calendar entry as it is until test mode is off. The Outreach summary says *Everything is posted* only once nothing is left as a test.
  - **Changes after posting:** when the title, date, start, end or place changes, the Google Group and Calendar rows say *Changed since posted*. **Update calendar** changes the entry already there (its id is in the Posts tab's `calendar id` column), with no second copy; if it was deleted, it adds a new one. **Draft an update** turns the Google Group row into a new draft, *Subject: Update: Seed swap, Sat 11/7*, which needs approving and posting like any other. The Posts tab's `stale` column says `yes` while a row is out of date.
  - **Partiful, Luma, Meetup, Facebook, Instagram and chats:** stay copy and paste (Luma's API needs a paid plan, and Partiful has none). **Copy text** puts the text on the clipboard and **Open Partiful** opens the site; copying alone never counts as posted. **Mark as posted** asks for the link to the post (optional, `https://` only) and then shows *Posted by Phil · Oct 25* with **View post**. **Undo** puts it back to approved.
  - The Posts tab keeps the trail in its own columns: `posted by`, `approved by`, `approved at`, `posted at` (times in UTC, like `2026-10-25T17:03:00.000Z`), `post url`, `calendar id` and `stale`. A link that doesn't start with `https://` isn't kept. The Activity tab says *Phil approved Partiful*, *Phil copied the Partiful text*, *Phil marked Partiful as posted*, *Phil un-marked Partiful*, *Phil posted to the Google Group* and *Phil updated the Calendar*.
- **Reminders:** every hour the script checks for events. The evening before and the morning of, it emails each person bringing something. People with only a phone number go on a "text these people" email to the host. If Gmail refuses one, the Reminders tab gets a `failed: ...` line, the others still go out, it's tried again the next hour, and the lead organizer gets one email a day listing what failed.
- **Email limits and replies:** replies to every email go to `REPLY_TO` on the Settings tab, or to the lead organizer's email on the Team tab when that's blank. When fewer than `MAIL_RESERVE` (30) emails are left for the day, welcome and new-volunteer emails wait so reminders can still go out; each one held back is a `skipped (quota): ...` line on the Reminders tab.
- **Safe values:** the server keeps only the four known photos, `https://` map and RSVP links, known tags or plain words up to 30 characters, titles up to 200 characters, descriptions up to 4,000 and "what to bring" up to 500. Event and task ids can use only letters, numbers, `-` and `_`; an Events row with any other id is listed on the Events page as a row to fix. The page escapes everything it shows from the Sheet.
- **Hand edits:** an organizer can fix the title, date, times, place, host, co-hosts, description, notes or timeline straight in the Sheet. The app shows the change on the next load. Dates can be typed as `2026-10-31`, `10/31/2026`, `10/31`, `Oct 31, 2026` or `October 31, 2026`, and times as `10:30 AM`, `10am` or `noon`. If a date still can't be read, that event is left off the Events page and a note there says which row to fix.
- **Columns:** the app finds each column by its header in row 1, so you can move columns or add your own between them. Don't rename or delete the headers the app made. When an update needs a new column, the app adds it at the right end of the tab. Bringing, Posts and Activity are rewritten by the app on every save, so personal notes belong on a separate tab, not in new columns there. Activity keeps the newest 100 lines per event.

## Safe testing

`TEST_MODE` is **TRUE** on the Settings tab, so **every email goes only to gistparent@gmail.com**, with the real recipient shown in the subject, and organizers see a yellow test-mode note on every page. Calendar events go on your own calendar. Nothing reaches the Google Group or the team.

To go live:
1. Put the Group's address in `GROUP_EMAIL`.
2. Fill in each person's email or phone on the Team tab.
3. Set `TEST_MODE` to FALSE.

## Moving it to a Guild account

Sign in to the Guild account and open the Sheet. Use **File → Make a copy**, which copies the script too. Then, in the copy, go to **Extensions → Apps Script**, run **setup**, and use **Deploy → New deployment → Web app** (Execute as: Me, Who has access: Anyone). The new web app gets a new link. Delete this copy afterwards.

## Known limits (fine for a pilot)

- The organizer code is one shared password. Permissions inside the app, such as who can approve and post, are honor-system; the server checks only the code. Someone guessing wrong 20 times pauses sign-in for everyone for up to 10 minutes.
- If two people save the same event in the same second, the last save wins. Different events are fine.
- An event's whole plan has to fit in one cell (45,000 characters). A save over that says "This event's plan is too long to save. Shorten the notes." and the Sheet keeps the last saved version.
- Gmail allows about 100 emails a day from a free account. `MAIL_RESERVE` keeps the last 30 for reminders.
- Texts aren't sent automatically. The host gets a list of people to text instead.
- There's also an empty test project called "ebpg-api-check" in Drive. Claude made it to check access, and you can delete it.

## For developers

```bash
npm install                      # once: the build uses acorn to read the page's JavaScript
python3 build.py                 # event-hub/src.html + src/bridge.js -> dist/ (runs gas-safe.js)
node --test test/                # all tests (or: npm test, which builds first)
                                 #   server.test.js: backend against a mock of Google's services
                                 #   smoke.test.js: the built site/ page in jsdom against that mock
                                 #   (landing, sign-in, saving an edit, volunteer sign-up, honest starter data)
node test/dev-server.js          # the real page + mock backend at http://localhost:8766/ (organizer code: garden-dev-1234)
                                 #   curl 'localhost:8766/_ctl?latency=3000&fail=saveEvent' makes the mock Sheet slow,
                                 #   and saveEvent answer with an HTML error page; '_ctl?latency=0&fail=' undoes it
                                 #   '_ctl?quota=20' leaves the mock Gmail 20 emails for the day
clasp push --force               # upload dist/ (after build.py)
netlify deploy --dir site --prod # publish site/ to https://ebpg-event-hub.netlify.app
clasp redeploy AKfycbxy4le3b-fRgH9BjhSZrcPf3TDcSgzMZ0sDnZEeRiZsCnPoX5jPVy6GU5DPtyoUjERf -d "update"
```

If the Apps Script deployment URL ever changes, update `API_URL` in `build.py` and redeploy the site.

**Watch out:** Apps Script's HtmlService deletes everything after `//` on a line of inline JavaScript. It respects normal quotes but not backtick strings, so a URL or base64 inside a template literal breaks the page. `gas-safe.js` rewrites those as `/\/` and fails the build if any `//` is left. If a script error happens, the page shows a friendly bar ("Something went wrong. Please refresh the page...") with a Dismiss button, and the details go to the browser console. Browser-extension errors, cross-origin "Script error." and ResizeObserver warnings are ignored. The bar's script is `on_err` in `build.py` (Netlify) and `ON_ERROR` in `src/Code.js` (Google-hosted page). Keep the two the same; a test checks this.

`event-hub/src.html` is still the prototype artifact's source. The live build swaps in `src/bridge.js` at the `/*__GAS_BRIDGE__*/` marker. The artifact build leaves that marker as an empty comment, so the artifact keeps working as before.

**Prototype-only content** in `src.html` sits between `<!--PROTO-->` and `<!--/PROTO-->` (HTML), or `/*PROTO*/` and `/*/PROTO*/` (CSS and JS), each marker on a line of its own. `build.py` removes those blocks before it adds the bridge, and fails if the markers don't pair up. `event-hub/build.py` keeps them, so the artifact still has its sample badges, "Viewing as" picker, Google button and "How we'd build it" page. It goes the other way too: the live page's wording is in the markup, and anything only the live page shows (the organizer code field, the Help tab, the signed-in chip) has `class="live"`, which the artifact hides.
