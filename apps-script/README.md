# EBPG Event Hub: live version (Google Sheets + Apps Script)

The Event Hub prototype, now saving to a real Google Sheet. The page is hosted on Netlify, and the Sheet and Apps Script do the saving, emails and reminders. Both are owned by gistparent@gmail.com for now.

| What | Link |
|---|---|
| The Sheet (the database) | https://drive.google.com/open?id=1zAE_ePxb1gFDo5r34mUVk82CBh5X1p3-wztvsqCx8HI |
| Script editor | https://script.google.com/d/1evyOeS39k_5SJVD2FcJ0j1LVqHtUj87COZAlYdB_yXI80AEn5UPtuSC4/edit |
| **The site (share this one)** | https://ebpg-event-hub.netlify.app |
| Apps Script web app (the API; also serves the old Google-hosted page) | https://script.google.com/macros/s/AKfycbxy4le3b-fRgH9BjhSZrcPf3TDcSgzMZ0sDnZEeRiZsCnPoX5jPVy6GU5DPtyoUjERf/exec |

## Morning: 5 minutes to turn it on

1. **Approve it once.** Open the script editor link and pick **setup** in the function menu at the top. Click **Run**, then **Review permissions**, and choose your account. Google will say *"Google hasn't verified this app"*. That's normal for a script you wrote yourself: click **Advanced → Go to EBPG Event Hub (unsafe) → Allow**. This sets up the Sheet tabs and the hourly reminder check.
2. **Open the site and sign in.** Go to https://ebpg-event-hub.netlify.app and you'll see the Guild's landing page. Click **Sign in**, type the organizer code `sprout-4821-bay`, and pick your name. The first sign-in on an empty Sheet fills it with the Guild's six events from the OPC planning notes and the team's names, roles and permissions. Contacts start blank, the volunteer list starts empty, and Workday #7 and Community Meeting #2 are drafts: their posts wait for review and their tasks need someone. This happens only once. Afterwards `SEEDED` on the Settings tab says TRUE, so emptying a tab by hand never brings the starter events back.
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
- **Organizer sign-in** with the organizer code. You can change the code on the **Settings** tab at any time. The header shows who is signed in.
- **Help tab** for organizers: where the data lives (with a link to the Sheet), the organizer code, test mode, when reminders go out, hand edits, and who the lead organizer is.
- **Events:** creating, editing, the host and co-hosts, the timeline and "who's bringing what" all save to the Sheet in under a second.
- **Post button:**
  - **Google Group:** sends the email.
  - **Calendar:** adds the event.
  - **Partiful, Luma, Meetup, Facebook, Instagram and chats:** stay copy and paste. Luma's API needs a paid plan, and Partiful has none.
- **Reminders:** every hour the script checks for events. The evening before and the morning of, it emails each person bringing something. People with only a phone number go on a "text these people" email to the host.
- **Hand edits:** an organizer can fix the title, date, times, place, host, co-hosts, description, notes or timeline straight in the Sheet. The app shows the change on the next load. Dates can be typed as `2026-10-31`, `10/31/2026`, `10/31`, `Oct 31, 2026` or `October 31, 2026`, and times as `10:30 AM`, `10am` or `noon`. If a date still can't be read, that event is left off the Events page and a note there says which row to fix.
- **Columns:** the app finds each column by its header in row 1, so you can move columns or add your own between them. Don't rename or delete the headers the app made. When an update needs a new column, the app adds it at the right end of the tab. Bringing, Posts and Activity are rewritten by the app on every save, so personal notes belong on a separate tab, not in new columns there. Activity keeps the newest 100 lines per event.

## Safe testing

`TEST_MODE` is **TRUE** on the Settings tab, so **every email goes only to gistparent@gmail.com**, with the real recipient shown in the subject. Calendar events go on your own calendar. Nothing reaches the Google Group or the team.

To go live:
1. Put the Group's address in `GROUP_EMAIL`.
2. Fill in each person's email or phone on the Team tab.
3. Set `TEST_MODE` to FALSE.

## Moving it to a Guild account

Sign in to the Guild account and open the Sheet. Use **File → Make a copy**, which copies the script too. Then, in the copy, go to **Extensions → Apps Script**, run **setup**, and use **Deploy → New deployment → Web app** (Execute as: Me, Who has access: Anyone). The new web app gets a new link. Delete this copy afterwards.

## Known limits (fine for a pilot)

- The organizer code is one shared password. Permissions inside the app, such as who can post, are honor-system; the server checks only the code.
- If two people save the same event in the same second, the last save wins. Different events are fine.
- An event's whole plan has to fit in one cell (45,000 characters). A save over that says "This event's plan is too long to save. Shorten the notes." and the Sheet keeps the last saved version.
- Gmail allows about 100 emails a day from a free account.
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
node test/dev-server.js          # the real page + mock backend at http://localhost:8766/
clasp push --force               # upload dist/ (after build.py)
netlify deploy --dir site --prod # publish site/ to https://ebpg-event-hub.netlify.app
clasp redeploy AKfycbxy4le3b-fRgH9BjhSZrcPf3TDcSgzMZ0sDnZEeRiZsCnPoX5jPVy6GU5DPtyoUjERf -d "update"
```

If the Apps Script deployment URL ever changes, update `API_URL` in `build.py` and redeploy the site.

**Watch out:** Apps Script's HtmlService deletes everything after `//` on a line of inline JavaScript. It respects normal quotes but not backtick strings, so a URL or base64 inside a template literal breaks the page. `gas-safe.js` rewrites those as `/\/` and fails the build if any `//` is left. If a script error happens, the page shows a friendly bar ("Something went wrong. Please refresh the page...") with a Dismiss button, and the details go to the browser console. Browser-extension errors, cross-origin "Script error." and ResizeObserver warnings are ignored. The bar's script is `on_err` in `build.py` (Netlify) and `ON_ERROR` in `src/Code.js` (Google-hosted page). Keep the two the same; a test checks this.

`event-hub/src.html` is still the prototype artifact's source. The live build swaps in `src/bridge.js` at the `/*__GAS_BRIDGE__*/` marker. The artifact build leaves that marker as an empty comment, so the artifact keeps working as before.

**Prototype-only content** in `src.html` sits between `<!--PROTO-->` and `<!--/PROTO-->` (HTML), or `/*PROTO*/` and `/*/PROTO*/` (CSS and JS), each marker on a line of its own. `build.py` removes those blocks before it adds the bridge, and fails if the markers don't pair up. `event-hub/build.py` keeps them, so the artifact still has its sample badges, "Viewing as" picker, Google button and "How we'd build it" page. It goes the other way too: the live page's wording is in the markup, and anything only the live page shows (the organizer code field, the Help tab, the signed-in chip) has `class="live"`, which the artifact hides.
