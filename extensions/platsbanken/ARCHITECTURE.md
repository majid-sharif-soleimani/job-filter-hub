# Platsbanken Job Filter (AI): Architecture

> Purpose of this file: give a developer or an AI assistant enough context to modify the extension safely.
> Keep it in sync with the code. When behavior changes, also add an entry to `CHANGELOG.md`.
> Built from the same design as `linkedin-job-filter` (same settings, providers, panel and cache ideas).

## 1. What the extension does

A Chrome extension (Manifest V3) for Platsbanken search result pages (`https://arbetsformedlingen.se/platsbanken/annonser?...`).
When the user clicks the toolbar icon, it:

1. Collects the ad cards on the current results page (25 per page). With the panel checkbox **Auto next page** ticked it
   presses **Nästa** after each page and continues until the last page or Stop.
2. Skips ads the user already applied to ("Ansökt") or already saved (heart), and ads saved by the extension before.
3. **Keyword filter (no AI):** a word from the keyword list in title, company, location or occupation → rejected.
4. **Location rule (no AI):** location not in the "commutable locations" list and not "Distans" → rejected.
5. Otherwise it opens the ad **without leaving the page** (Platsbanken has no preview pane):
   - `openMode: "iframe"` (default): a hidden, off-screen, same-origin iframe loads `/platsbanken/annonser/<id>`;
   - `openMode: "tab"`: background.js opens an inactive tab next to the results tab, reads it, closes it;
   - fallback for both: the JSON endpoint the site itself uses, `platsbanken-api.arbetsformedlingen.se/jobs/v1/job/<id>`.
6. Sends the ad text with the resume and hard criteria to the chosen AI model (Claude, OpenAI, Gemini or TypeSafe Jev).
7. Match → green badge, and (option `saveMatches`) presses the card's heart "Spara annons" (never un-saves).
   No match → red badge, and the card is dimmed or hidden (option `markRejected`). There is no "dismiss" on Platsbanken.
8. Shows a draggable floating panel with progress, a summary and a per-ad log (each entry links to the ad).
9. The **Externa webbplatser** tab (ads from other job sites) is handled too, see section 5b. With Auto next page, the run
   switches to that tab after the last Platsbanken page (`includeExternal`).
10. Results are cached; with `showPrevious` the badges from earlier runs appear on every results page without a run.

## 2. Files

| File | Runs in | Responsibility |
|---|---|---|
| `manifest.json` | – | MV3 manifest. Content scripts `extract.js` + `content.js` on `/platsbanken/*` (top frame only). Host permissions for the site, its API and the AI providers. |
| `settings.js` | background (`importScripts`) and options page | `AFJF_DEFAULTS` and `afjfGetSettings()`. The criteria writing guide is at the top. |
| `background.js` | service worker | Toolbar click, AI provider calls, prompt, JSON parsing, retries, toolbar badge, and the "background tab" open mode (`extractInTab`). |
| `extract.js` | page (isolated world) | `window.__afjfExtract(document)`: waits for an ad page (Platsbanken or external summary page) to render and returns `{title, company, detailText}` (+ `location`, `sourceUrl` for external pages). Used on the iframe's document and in background tabs. Also `__afjfHtmlToText`. |
| `content.js` | results page (isolated world) | DOM scraping, main loop, open modes, keyword/location rules, saving, pagination, cache, badges/dimming, panel UI. |
| `options.html` / `options.js` | options page | Settings form. Saving also clears `scoreCache`. "Save & test API" scores a fake ad. |
| `icons/` | – | Toolbar icons. |

## 3. Message flow

```
[toolbar click] → background.js chrome.action.onClicked
    ├─ no API key or no resume → opens the options page
    ├─ not a /platsbanken/annonser search URL → toolbar badge "?"
    └─ chrome.tabs.sendMessage(tab, {type:"AFJF_TOGGLE"})   (injects extract.js + content.js if needed)

content.js run():  for each card (sequential) ──► openAndExtract (iframe | tab | API fallback)
                                    └─► chrome.runtime.sendMessage({type:"AFJF_SCORE", job})   (max 5 in flight)
background.js scoreJob(job) ──► provider API ──► {score, decision, reason}
content.js applyResult() ◄── badge, save (match) or dim/hide (reject)

content.js → background: {type:"AFJF_EXTRACT_TAB", url}   ("tab" mode; background opens, reads, closes the tab)
content.js → background: {type:"AFJF_FETCH_SOURCE", url, allowTab}  (external ad: read the full ad on its source site)
content.js → background: {type:"AFJF_STATE", running, progress}  (toolbar badge text)
```

## 4. Storage (`chrome.storage.local`)

| Key | Shape | Notes |
|---|---|---|
| `settings` | see below | Written by options.js. |
| `scoreCache` | `{ [adId]: {score, decision, reason, ts} }` | Writes are serialized (`putCache`). Cleared when settings are saved. Also kept in memory (`cacheMem`) for the earlier-results badges. |
| `savedIds` | `string[]` (last 5000) | Ads saved by the extension (or found already saved); skipped in later runs. |
| `autoNext` | boolean | Panel checkbox. |

Page `localStorage`: `afjf-panel-pos`, `afjf-panel-expanded`. `sessionStorage["afjf-autorun"]` holds the next page number while a
Nästa click is pending (if the page reloads, the new script continues). Platsbanken's own saved ads live in its
`localStorage["platsbanken.savedAds"]`; the extension only touches them through the heart button.

### `settings` object

```js
{
  provider: "anthropic" | "openai" | "gemini" | "typesafe",
  models, apiKeys,          // per provider, stored only locally
  threshold: 55,            // keep an ad only if decision=="match" && score >= threshold
  delaySec: 0,              // pause after opening each ad
  openMode: "iframe" | "tab",
  dryRun: false,            // badge only: no dimming/hiding, no saving
  saveMatches: true,        // press the heart on matching ads
  markRejected: "dim" | "hide" | "none",
  showPrevious: true,       // show cached badges on every results page
  includeExternal: true,    // after the last Platsbanken page, continue with the Externa webbplatser tab
  readExternalSource: true, // read the full external ad on its source site (optional host permission)
  blockKeywords: "",        // comma/newline separated, NOT trimmed; substring match on title/company/location/occupation
  commuteLocations: "",     // comma separated, whole word; empty = rule disabled
  criteria: "...", resume: "..."
}
```

## 5. Platsbanken DOM (as of 2026-11; Angular app with "digi" web components)

| Thing | Selector / source | Notes |
|---|---|---|
| Ad card | `pb-feature-search-result-card` | Contains `h3 > a[href="/platsbanken/annonser/<id>"]` (the link also holds a hidden " (1 jobb)" span). |
| Card fields | `.pb-company-name`, `.pb-workplaces` ("Stockholm (På plats)"), `.pb-job-role`, `.pb-job-date` | |
| Applied | `pb-feature-applied-indicator` **without** `[hidden]` | Shows "Ansökt". |
| Save (heart) | `pb-feature-save-job digi-button[af-id="save-ad-btn"]` → inner `button` | `aria-label` "spara annons, …" ↔ "annonsen är sparad, …". Toggle: only clicked when not saved. Works without login (stored in the site's localStorage). |
| Pagination | `digi-navigation-pagination` (`af-total-pages`), next = `.digi-navigation-pagination__button--next` (inner button `aria-label="Nästa"`) | Hidden on the last page (`…__button--hidden`). SPA navigation, URL gets `&page=N`. |
| Ad page | `main h1` (title), first visible `h2` after it (employer), `.job-description` (full text, also when collapsed behind "Läs mer") | Header text up to "Om jobbet"; "Övrig information" up to "Dela annonsen" (salary, address). |
| Ad JSON | `GET https://platsbanken-api.arbetsformedlingen.se/jobs/v1/job/<id>` | Public, CORS allowed for the site. `description` is HTML. Used only as a fallback. |

### 5b. "Externa webbplatser" tab

| Thing | Selector / source | Notes |
|---|---|---|
| Tabs | `div[role=tablist] > button[role=tab]`, `aria-label` "Platsbanken (66 annonser)" / "Externa webbplatser (11 annonser)", `aria-selected` | The Externa tab adds `&s=2` to the URL. Same card component and pagination as Platsbanken. |
| External card | same `pb-feature-search-result-card`, link `/platsbanken/annonser/joblinks/<hex hash>` | Company and location are empty on the card. Same save heart and applied indicator. `isExternalId(id)` = not all digits. |
| Summary JSON | `GET platsbanken-api.arbetsformedlingen.se/jobs/v1/job/joblinks/<hash>` | `{title, company.name, description (~300 chars), occupation, publishedDate, sourceLinks:[{label,url}], workplaces:[{municipality, region}]}` |
| External ad page | `pb-page-external-job`: `h1.d-block`, `.description`, `ul.link-external a` (source link), "Kommun: …" | Fallback in `extract.js` when the JSON endpoint fails. |
| Source site | `background.js readSourcePage()` | Needs the optional host permission `https://*/*` (requested in options.js inside the click handler). 1) `fetch` the HTML and take the schema.org `JobPosting` from `<script type="application/ld+json">` (incl. `@graph`), else `<main>`/`<article>` text; 2) if < 600 chars, open the URL in an inactive tab and read `main`'s `innerText` (`readSourceInTab`). Tested 2026-11: ledigajobb.se, workmatch.io, studentjob.se → JSON-LD; ingenjorsjobb.se → tab. |

The text sent to the AI starts with a header (title, company, location, occupation, source host) followed by either the full source
ad or the Platsbanken summary plus a NOTE that only a summary was available (the system prompt says not to reject for missing details).

The hidden iframe must stay rendered (off-screen with `left:-12000px`), because `visibility:hidden`/`display:none` would make
`innerText` empty. An ad page loads in about 1 s. The content script only runs in the top frame (it returns early inside our iframe).

**When the site changes:** clicking the icon on a page without cards shows a diagnostic in the panel and console (`[AFJF]`).
Update `CARD_SEL`/`cardInfo`/`findSaveButton`/`findNextButton` in `content.js` and the selectors in `extract.js`.

## 6. Conventions and gotchas

- Never dim/hide or save in `dryRun` mode.
- Any change to resume or criteria must invalidate `scoreCache` (saving the options page does this).
- Keys stay local; network calls go only to the AI provider, arbetsformedlingen.se and (with the optional permission) the source sites of external ads.
- After editing: reload the extension in `chrome://extensions` **and** refresh the Platsbanken tab.
- Testing without API credits: inject `extract.js` + `content.js` into the results page with a stubbed `window.chrome`
  (`runtime.sendMessage` returning `{ok:true,result:{score,decision,reason}}`, in-memory `storage.local`, `onChanged`).
- Bump `manifest.json` → `version` and add a `CHANGELOG.md` entry for every change.
