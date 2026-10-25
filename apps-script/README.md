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
2. **Open the web app link.** You'll see the Guild's landing page. Click **Sign in**, type the organizer code `sprout-4821-bay`, and pick a name. The first sign-in fills the empty Sheet with the six starter events, the team and the volunteers.
3. **If the link still says "Access Denied":** in the script editor go to **Deploy → Manage deployments → ✏️**. Set *Execute as* to **Me** and *Who has access* to **Anyone**, then click **Deploy**. Or just tell Claude, and it will redeploy.

## How the pieces fit

- **Netlify** serves the page (`site/index.html`). It's fast, has no Google banner, and could use the Guild's own domain later.
- **The page** sends each save as a POST to the Apps Script web app (`doPost`). Only seven page functions can be called, and every organizer action checks the organizer code.
- **Apps Script** reads and writes the Sheet, sends email through Gmail and adds Calendar events. The hourly reminder trigger runs there too.
- **The old Google link** still works. Put `https://ebpg-event-hub.netlify.app` in `SITE_URL` on the Settings tab and it will send visitors to Netlify instead.
- **Netlify settings:** the site was created with Netlify's "visitor access: Netlify login" protection on. It was switched off so the public can open the page.

## What works

- **Landing page** for the public: upcoming events, a garden map and the volunteer sign-up. Sign-ups go to the **Volunteers** tab. The volunteer gets a welcome email and the lead organizer gets a "new volunteer" email.
- **Organizer sign-in** with the organizer code. You can change the code on the **Settings** tab at any time.
- **Events:** creating, editing, the host and co-hosts, the timeline and "who's bringing what" all save to the Sheet in under a second.
- **Post button:**
  - **Google Group:** sends the email.
  - **Calendar:** adds the event.
  - **Partiful, Luma, Meetup, Facebook, Instagram and chats:** stay copy and paste. Luma's API needs a paid plan, and Partiful has none.
- **Reminders:** every hour the script checks for events. The evening before and the morning of, it emails each person bringing something. People with only a phone number go on a "text these people" email to the host.
- **Hand edits:** an organizer can fix the title, date, times, place, host, co-hosts, description, notes or timeline straight in the Sheet. The app shows the change on the next load.

## Safe testing

`TEST_MODE` is **TRUE** on the Settings tab, so **every email goes only to gistparent@gmail.com**, with the real recipient shown in the subject. Calendar events go on your own calendar. Nothing reaches the Google Group or the team.

To go live:
1. Put the Group's address in `GROUP_EMAIL`.
2. Swap the placeholder team members on the Team tab for real names and emails.
3. Set `TEST_MODE` to FALSE.

## Moving it to a Guild account

Sign in to the Guild account and open the Sheet. Use **File → Make a copy**, which copies the script too. Then, in the copy, go to **Extensions → Apps Script**, run **setup**, and use **Deploy → New deployment → Web app** (Execute as: Me, Who has access: Anyone). The new web app gets a new link. Delete this copy afterwards.

## Known limits (fine for a pilot)

- The organizer code is one shared password. Permissions inside the app, such as who can post, are honor-system; the server checks only the code.
- If two people save the same event in the same second, the last save wins. Different events are fine.
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
                                 #   (landing, sign-in, saving an edit, volunteer sign-up)
node test/dev-server.js          # the real page + mock backend at http://localhost:8766/
clasp push --force               # upload dist/ (after build.py)
netlify deploy --dir site --prod # publish site/ to https://ebpg-event-hub.netlify.app
clasp redeploy AKfycbxy4le3b-fRgH9BjhSZrcPf3TDcSgzMZ0sDnZEeRiZsCnPoX5jPVy6GU5DPtyoUjERf -d "update"
```

If the Apps Script deployment URL ever changes, update `API_URL` in `build.py` and redeploy the site.

**Watch out:** Apps Script's HtmlService deletes everything after `//` on a line of inline JavaScript. It respects normal quotes but not backtick strings, so a URL or base64 inside a template literal breaks the page. `gas-safe.js` rewrites those as `/\/` and fails the build if any `//` is left. The page also shows any script error in a red bar at the bottom, instead of failing silently inside Google's frame.

`event-hub/src.html` is still the prototype artifact's source. The live build swaps in `src/bridge.js` at the `/*__GAS_BRIDGE__*/` marker. The artifact build leaves that marker as an empty comment, so the artifact keeps working as before.
