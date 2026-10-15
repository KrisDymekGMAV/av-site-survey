# AV Site Survey — installable app (PWA)

One set of files gives you both versions:

- **Android app** — open the link in Chrome → menu ⋮ → **Install app**. Opens full screen with its own icon, and works with no signal.
- **Web app** — the same link in any desktop browser (Chrome/Edge can also install it).

Everything is saved on the device first (IndexedDB). When there is signal and you are connected to Google Drive, surveys, photos, voice clips and reports upload to the Drive folder you choose.

## Files

| File | What it is |
|---|---|
| `index.html` | App page |
| `app.js` | All app logic |
| `styles.css` | Styling (light and dark mode) |
| `config.js` | **Your Google settings — edit this** |
| `sw.js` | Service worker — makes the app work offline |
| `manifest.webmanifest` | Makes it installable (name, icon, colours) |
| `jspdf.umd.min.js` | PDF library (jsPDF 3.0.4, MIT licence — see `jspdf-LICENSE.txt`), bundled so reports work offline |
| `icon-*.png`, `maskable-512.png`, `apple-touch-icon.png` | App icons (in the main folder, next to `index.html`) |

The app works without any Google setup — it just stays "saved on this phone only" until `config.js` is filled in.

---

## 1. Host it (free)

A PWA must be served over **HTTPS** from a real web address. GitHub Pages is the simplest:

1. Create a GitHub account if you don't have one, then a new **public** repository, e.g. `av-site-survey`.
2. **Add file → Upload files**, drag in everything from this folder, commit.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
4. After a minute the app is at `https://YOUR-USERNAME.github.io/av-site-survey/`.

Netlify or Cloudflare Pages work the same way (drag-and-drop the folder).

> A public GitHub repo means the app's *code* is public. Your surveys are not — they live on the phone and in your Google Drive. `config.js` contains a Client ID and an API key; both are designed to be visible in web pages, and are locked to your web address in the steps below.

**Testing on your computer first:** in this folder run `python3 -m http.server 8080` and open `http://localhost:8080`. (Localhost counts as secure, so offline mode and Google sign-in work there too.)

## 2. Google Cloud setup (for Drive sync)

Google renames these menus from time to time; if a label doesn't match exactly, look for the nearest equivalent.

1. Go to <https://console.cloud.google.com>, sign in with your work Google account, and **create a new project** (e.g. "AV Site Survey").
2. **APIs & Services → Library**: enable **Google Drive API** and **Google Picker API**.
3. **OAuth consent screen** (may appear as *Google Auth Platform → Branding / Audience*):
   - If your email is a **Google Workspace** account, choose **Internal**. Only people in your organisation can sign in, and Google app verification isn't needed.
   - If it's a personal Gmail account, choose **External**, leave it in **Testing**, and add each user's email under **Test users** (up to 100). Users will see an "unverified app" warning they can click through.
   - Add the scope `https://www.googleapis.com/auth/drive`.
4. **Credentials → Create credentials → OAuth client ID** → type **Web application**.
   Under **Authorized JavaScript origins** add your site's origin only (no path), e.g. `https://YOUR-USERNAME.github.io`, plus `http://localhost:8080` for testing. Copy the **Client ID**.
5. **Credentials → Create credentials → API key**. Edit it: restrict it to the **Google Picker API**, and set *Website restrictions* to `https://YOUR-USERNAME.github.io/*` (and `http://localhost:8080/*`). Copy the key.
6. **Project number**: shown on the project dashboard / *IAM & Admin → Settings*. (Number, not the project ID.)
7. Put the three values in `config.js`.
8. In `sw.js`, change `const CACHE = 'avss-v1.0.0'` to a new value (e.g. `avss-v1.0.1`) and upload both files. **Do this every time you change any file**, otherwise installed phones keep the old cached copy.

### About the Drive permission

`config.js` uses the full Drive scope by default. With it, everyone can save into a shared folder and reuse site folders created by colleagues. The narrower `drive.file` scope only lets the app see files that *that person's* app created or picked, so colleagues would get duplicate folders and couldn't open each other's sites from Drive. For an internal Workspace app the full scope needs no Google review.

## 3. Install on Android

1. Open your app link in **Chrome**.
2. Menu ⋮ → **Install app** (older Chrome: *Add to Home screen*).
3. Open it once with signal so it caches itself. From then on it opens with no signal.

## 4. Using a shared Drive folder

1. In Google Drive, create a folder (e.g. *AV Surveys*) — in My Drive or a Shared drive — and **share it with colleagues as Editor**.
2. In the app: the **Where to save surveys** screen appears on first start (later: **Change** on the home screen's *Saving to* card). Pick **Phone + Google Drive folder → Connect Google Drive → Choose folder**. Either browse (My Drive, Shared with me, Shared drives) or paste the folder link.
   If the Drive option is greyed out, `config.js` hasn't been filled in yet (section 2).
3. **Send app link with this folder to a colleague** — they open it, install the app, and the folder is pre-selected. They still need to connect their own Google account.

Folder layout created by the app:

```
AV Surveys/                      ← the folder you chose
  Aintree Hospital/              ← one per site
    site-data.json               ← full survey data (used by "Open a site from this folder")
    Warehouse Bay C/             ← one per space
      Warehouse Bay C photo 01 - Display wall.jpg
      Warehouse Bay C voice 01.webm
      Aintree Hospital - Warehouse Bay C survey 2026-10-14.md
```

**Another device / colleague:** home screen → **Open site from Drive** lists the sites in the folder; pick one to load it. Their changes then upload back to the same `site-data.json`.

## 5. PDF reports

- **Site → PDF report** makes one report for every space at the site; **PDF report for this space** at the bottom of a space makes a single-space report.
- Contents: cover page (site, client, contact, survey date, surveyor, list of spaces), then per space: details, client requirements, measurements and display-size estimate, environment, infrastructure, existing equipment, notes, voice-note list, checklist and photos (two per row, with captions).
- When it's ready choose **Share** (email, Teams, WhatsApp…), **Download**, or **Save to Google Drive** (uploads into the site or space folder, now or when back online).
- Works offline. Full-size photos on the phone are used; if a photo is only in Drive, it's downloaded when connected, otherwise the thumbnail is used and marked *low-resolution preview*.
- **Branding:** ⚙ Settings → *Report branding* — logo (PNG or JPG; transparent PNG looks best), company name (top of each page) and footer text. Stored per phone.
- The built-in PDF fonts only cover Western European characters. Polish and other accented letters print without accents (e.g. ł → l, ż → z) rather than as garbage.

## 6. How offline and sync work

- Every change saves to the phone immediately. The bar under the header shows what's waiting.
- Photos are stored full size (up to 3000 px) plus a thumbnail; voice clips up to 10 minutes.
- Uploads run automatically when there is signal **and** you're connected. Google sign-in lasts about an hour; after that the bar says *Tap to connect Google Drive* — one tap.
- Failed uploads retry up to 6 times, then show under Settings with the error and a **Retry** button.
- **Settings → Free up space** removes full-size files that are already in Drive (thumbnails stay).

## 7. Moving surveys from the Claude version

In the old app: open the site → **Export site data for import (.json)**. In this app: home → **Import site file**. Survey fields, captions, checklists and in-app voice clips come across. Photos that were in Drive come across as links; photos stored only inside the Claude app can't be exported, so re-take or download them first.

## 8. Known limits — please test before relying on it

- The Drive sign-in, folder picker and uploads were written against Google's documented APIs but **have not been run against a live Google account**. Test with one small site end-to-end first.
- If two people edit the **same site at the same time**, the last one to upload `site-data.json` wins. Photos and clips are never overwritten (each is its own file).
- Renaming a site or space renames its Drive folder on the next sync; deleting in the app does **not** delete anything in Drive.
- **Dictation** uses the phone's speech recognition, which normally needs signal. Voice clips record offline.
- The folder picker is a Google component; on small screens it can be cramped. Pasting the folder link is the fallback.
- Android may clear app data for un-installed web apps under storage pressure. Installing the app (and checking *Settings → Storage* shows "Protected") avoids this.
- No auto-fill from notes in this version.

## 9. Want a real APK later?

The same files can be wrapped as an Android package (for the Play Store or company device management) using **PWABuilder** (<https://www.pwabuilder.com>) or Google's **Bubblewrap**. That's optional — the Chrome install already behaves like an app.
