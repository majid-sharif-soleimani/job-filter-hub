# Job Filter Hub (AI)

One Chrome extension that bundles five AI job filters. It is only an entry point: on each site it runs that site's own filter, with the same panel, settings page and behaviour as the standalone extension.

| Site | Bundled extension | Source |
|---|---|---|
| LinkedIn | `extensions/linkedin/` (LinkedIn Job Filter 1.10.8) | [linkedin-job-filter](https://github.com/majid-sharif-soleimani/linkedin-job-filter) @ `08cf465` |
| Indeed | `extensions/indeed/` (Indeed Job Filter 1.5.3) | [indeed-job-filter](https://github.com/majid-sharif-soleimani/indeed-job-filter) @ `2c77720` |
| consultant.dev | `extensions/consultant/` (Consultant.dev Job Filter 1.0.0) | consultant-job-filter.zip |
| Platsbanken | `extensions/platsbanken/` (Platsbanken Job Filter 1.1.0) | platsbanken-job-filter.zip |
| Jobbsafari | `extensions/jobbsafari/` (Jobbsafari Job Filter 1.0.0) | written for this hub, from consultant-job-filter (also works standalone) |

The files in `extensions/<id>/` are exact copies of the originals and are never edited (Jobbsafari has no separate original; it is maintained here).

## Install

1. Uninstall (or turn off) the standalone extensions, otherwise each site gets two panels.
2. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick this folder.
3. Click the toolbar button anywhere outside the supported sites (or open the extension's options) to get the hub page. Open **Settings** for a site, enter the API key and resume, then use **Copy AI settings and resume** to fill in the other sites.

Settings from the old standalone extensions can't be carried over automatically (Chrome keeps each extension's storage separate), so they have to be entered once here.

## Job tracker and the Gmail menu

- Every job that a filter's AI marks as a **match** is saved as a record (title, company, site, AI score, page link) with the status **Matched**. If the same job is scored again, its status and notes are kept.
- On **Gmail**, a **💼 Jobs** button at the bottom right (or the toolbar button) opens a menu. It reads the open email (subject, sender, text), finds the matching records by company name, sender domain and job title, and lets you change the status (Matched, Applied, Interview, Offer, Rejected, Withdrawn) and notes. If nothing matches, you can search all records or add the email as a new record.
- The hub page (toolbar button on any other site, or the extension's options) lists all records with search, status, notes and delete.
- Everything stays in the browser (`chrome.storage.local`, key `hub::applications`). The email is only read on the page and is never sent anywhere.

## How it works

- **Toolbar button**: the click goes to the filter of the site in the active tab. On any other page it opens the hub page.
- **Background**: Chrome allows one service worker per extension, so `background.js` loads a small router (`hub/router.js`) and each site's original `background.js` inside its own function scope (`generated/<id>/background.js`). Each one gets its own `chrome` object that only differs in: toolbar clicks (only for its site), messages (only its own `LJF_` / `IJF_` / `CJF_` / `AFJF_` / `JSJF_` types), `openOptionsPage()` (its own settings page), injected file paths, and storage.
- **Storage**: all of them use the same key names (`settings`, `scoreCache`, ...). Each site's data is stored under its own prefix (`linkedin::settings`, ...) by `hub/storage-ns.js` and `hub/page-shim.js`, which run before the original content scripts and settings pages.
- **Manifest**: merged from the sub-extensions' manifests (permissions, host permissions, content scripts per site).

## Updating a bundled extension

Copy the new version over `extensions/<id>/` (without its `.git`), then run:

```
node tools/build.mjs
```

This regenerates `manifest.json`, `background.js` and `generated/`. Commit the result; Chrome loads the generated files directly, so nothing needs to be built after cloning.

Adding a new site: copy its extension to `extensions/<id>/`, add an entry to `hub/subs.js` (id, name, message prefix, site URL pattern) and rebuild.
