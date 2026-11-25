# Jobbsafari Job Filter (AI): Architecture

> Built from consultant-job-filter 1.0.0; the sections below are inherited from it and adapted. Message/storage prefix: `JSJF_` / `jsjf-`.

## jobbsafari.se specifics (as of 2026-11)

| Thing | How it is found | Notes |
|---|---|---|
| List page | `/lediga-jobb`, `/lediga-jobb/ort/<city>`, `/yrke/…`, `/kategori/…`, `/arbetsplats/distans` | Server-rendered, 30 ads per page. |
| Card | the largest element around one link `a[href*="/jobb/"]` matching `/jobb/<slug>-<numeric id>` | No class names are relied on. |
| Id | the numeric last part of the ad URL | |
| Title / company / location | heading or text lines of the card; location = line before the date range ("20/11 – 31/12") | Badges "Rekommenderat", "Ansök utan CV", "N dagar kvar" are skipped. |
| Ad page | fetched with `fetch()` (same origin) | JSON-LD `JobPosting` if present; description from `#description` / the "Beskrivning" section; else `main`. |
| Next page | link with `?page=N+1` on the same path | Full page load: the page to resume is kept in `sessionStorage` (`jsjf-resume-page`) and the run continues after the load if "Auto next page" is on. |
| Save | not supported | |

The DOM selectors were written from the site's public structure without the raw HTML; if a run shows
"No job ads found", the panel prints a diagnostic to adjust `content.js` (DOM helpers section).

---

> Ported from `linkedin-job-filter` 1.10.8 (same settings, AI providers and panel). Message/storage prefix: `CJF_` / `cjf-`.

## 1. What it does

On a jobbsafari.se results page (`https://jobbsafari.se/search?...`), a toolbar click:

1. Collects the ad cards on the current page (`article.ad-row`).
2. Skips cards already saved by the user (heart button `aria-pressed="true"`).
3. Assignments rejected in an earlier run (`rejectedIds`, or a cached reject) are hidden again without an AI call.
4. **Keyword rule (no AI):** a keyword found in title, company or location → reject.
5. **Location rule (no AI):** location not in the "commutable locations" list and not remote → reject.
6. Otherwise it **fetches** `/ads/<id>` (server-rendered HTML, same origin, no tab is opened), extracts the text
   and sends it to the AI (Claude, OpenAI, Gemini or TypeSafe Jev) with the resume and hard criteria.
7. Reject = remember the id in `rejectedIds` and hide the card (`display:none`), or fade it (opacity .45) when
   "Hide rejected" is off. jobbsafari.se has no "not interested" action, so hiding is done by the extension on every visit.
8. Matches can be saved with the site's heart button at the end of the page (option `saveMatches`, needs sign-in).
9. "Auto next page" clicks Next in the pager and continues until Stop or the last page.

## 2. Files

| File | Runs in | Responsibility |
|---|---|---|
| `manifest.json` | – | MV3. Content script on `https://jobbsafari.se/*` (top frame only). Host permissions for the site and the AI APIs. |
| `settings.js` | background + options | `CJF_DEFAULTS`, `cjfGetSettings()`, criteria writing guide. |
| `background.js` | service worker | Toolbar click, AI provider calls, prompt, JSON parsing, retries, toolbar badge. |
| `content.js` | jobbsafari.se page | DOM scraping, fetching ad pages, main loop, hiding, badges, panel. |
| `options.html` / `options.js` | options page | Settings form; Save clears `scoreCache`; "Forget rejected ads" clears `rejectedIds` and `scoreCache`. |

## 3. Messages

`chrome.action.onClicked` → (no key/resume → options page) → (not `/search` → badge "?") → `CJF_TOGGLE` to the tab
(injects `content.js` if missing). Content → background: `CJF_SCORE {job}` → `{ok, result:{score, decision, reason}}`
(max 5 in flight) and `CJF_STATE {running, progress}` for the toolbar badge.

## 4. Storage (`chrome.storage.local`)

| Key | Shape | Notes |
|---|---|---|
| `settings` | see `settings.js` | Adds `hideRejected` (default true) and `saveMatches` (default false) to the LinkedIn version. `delaySec` default 0.5 (pause between page fetches). |
| `scoreCache` | `{ [id]: {score, decision, reason, ts} }` | Cleared when settings are saved. Also used to show badges after a reload. |
| `rejectedIds` | `string[]` (last 10000) | Hidden on every visit (re-applied every second). |
| `autoNext` | boolean | Panel checkbox. |

Page `localStorage`: `cjf-panel-pos`, `cjf-panel-expanded`.


## 6. Gotchas

- Never hide or save in `dryRun`.
- Rejected ids are only the extension's own memory: "Forget rejected ads" brings them back.
- After editing: reload the extension in `chrome://extensions` and refresh the jobbsafari.se tab.
- Testing without API cost: run `content.js` wrapped as `(function(chrome){…})(stub)` in the page, with a stub whose
  `runtime.sendMessage` returns `{ok:true,result:{score,decision,reason}}` and an in-memory `storage.local`.
