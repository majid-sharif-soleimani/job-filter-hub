# Consultant.dev Job Filter (AI): Architecture

> Purpose: give a developer or an AI assistant enough context to modify the extension safely.
> Keep it in sync with the code; add a `CHANGELOG.md` entry and bump `manifest.json` → `version` for every change.
> Ported from `linkedin-job-filter` 1.10.8 (same settings, AI providers and panel). Message/storage prefix: `CJF_` / `cjf-`.

## 1. What it does

On a consultant.dev results page (`https://consultant.dev/search?...`), a toolbar click:

1. Collects the assignment cards on the current page (`article.assignment-row`).
2. Skips cards already saved by the user (heart button `aria-pressed="true"`).
3. Assignments rejected in an earlier run (`rejectedIds`, or a cached reject) are hidden again without an AI call.
4. **Keyword rule (no AI):** a keyword found in title, company or location → reject.
5. **Location rule (no AI):** location not in the "commutable locations" list and not remote → reject.
6. Otherwise it **fetches** `/assignments/<id>` (server-rendered HTML, same origin, no tab is opened), extracts the text
   and sends it to the AI (Claude, OpenAI, Gemini or TypeSafe Jev) with the resume and hard criteria.
7. Reject = remember the id in `rejectedIds` and hide the card (`display:none`), or fade it (opacity .45) when
   "Hide rejected" is off. consultant.dev has no "not interested" action, so hiding is done by the extension on every visit.
8. Matches can be saved with the site's heart button at the end of the page (option `saveMatches`, needs sign-in).
9. "Auto next page" clicks Next in the pager and continues until Stop or the last page.

## 2. Files

| File | Runs in | Responsibility |
|---|---|---|
| `manifest.json` | – | MV3. Content script on `https://consultant.dev/*` (top frame only). Host permissions for the site and the AI APIs. |
| `settings.js` | background + options | `CJF_DEFAULTS`, `cjfGetSettings()`, criteria writing guide. |
| `background.js` | service worker | Toolbar click, AI provider calls, prompt, JSON parsing, retries, toolbar badge. |
| `content.js` | consultant.dev page | DOM scraping, fetching assignment pages, main loop, hiding, badges, panel. |
| `options.html` / `options.js` | options page | Settings form; Save clears `scoreCache`; "Forget rejected assignments" clears `rejectedIds` and `scoreCache`. |

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

## 5. consultant.dev DOM (as of 2026-11, Nuxt/Vue)

| Thing | Selector | Notes |
|---|---|---|
| Card | `article.assignment-row` | 20 per page. |
| Id | `a.assignment-row__open[href="/assignments/<id>"]` (also `data-testid="srp-card-<id>"`) | Id = 12 alphanumeric chars. |
| Title | `h3.job-title` | |
| Company / location | `.assignment-row__location` > `span.assignment-row__company`, then `span` "City, Region · Hybrid" | Further spans can hold a rate ("35,000 GBP to 45,000 GBP/year") or `span.assignment-row__closing` ("Closes in 2 days"); `cardLocation()` skips those. |
| Skills | `.assignment-row__skills > span` | `.assignment-row__skills-more` = "+N". |
| Snippet | `p.assignment-row__snippet` | Not on every card. |
| Save | `button.assignment-row__save[aria-pressed]` | Heart. Signed out: header has `/sign-in` / `/sign-up` links → saving is skipped. |
| Pager | `.srp-pager > button.srp-page-btn` ("Previous 1 2 … 219 Next") | SPA: Next changes the URL to `&page=N` (drops `tab=all`) without a reload. |
| Assignment page | `.assignment-detail__main`: `h1.jd-title`, `.jd-co-name`, `.jd-co-src` ("via Adzuna"), `.jd-co-posted`, `dl.jd-facts` (Location, Work mode, Seniority…), `.jd-skills__list li`, `.jd-prose` | Some sources only give a shortened description ending in "…". `.asct` (sign-up box) is removed. |

## 6. Gotchas

- Never hide or save in `dryRun`.
- Rejected ids are only the extension's own memory: "Forget rejected assignments" brings them back.
- After editing: reload the extension in `chrome://extensions` and refresh the consultant.dev tab.
- Testing without API cost: run `content.js` wrapped as `(function(chrome){…})(stub)` in the page, with a stub whose
  `runtime.sendMessage` returns `{ok:true,result:{score,decision,reason}}` and an in-memory `storage.local`.
