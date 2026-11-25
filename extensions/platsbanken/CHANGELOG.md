# Changelog

All notable changes. Newest first. Versions match `manifest.json` → `version`.

## [1.1.0] - 2026-11-24
### Added
- **"Externa webbplatser" tab.** Ads from other job sites (`/platsbanken/annonser/joblinks/<hash>`) are now checked too; before,
  their non-numeric ids were not recognized and they were skipped.
  - Title, company, municipality, occupation and the source link come from Platsbanken's endpoint
    `jobs/v1/job/joblinks/<hash>` (fallback: the hidden iframe / background tab reads the external ad page).
  - Platsbanken shows only a ~300 character summary, so the **full ad is read on the source site** (ledigajobb.se, workmatch.io,
    studentjob.se, thehub.io, …): the schema.org JobPosting (JSON-LD) from the page HTML, or the rendered page in a background tab
    for JavaScript-only sites (e.g. ingenjorsjobb.se). Needs the optional "all sites" permission, asked on the options page
    (setting `readExternalSource`). Without it the summary is scored and the AI is told that details are missing.
  - Keyword and location rules run again on the company and municipality read from the API (external cards show neither).
  - Log entries say whether the full ad or only the summary was scored.
- With **Auto next page**, after the last Platsbanken page the run switches to the Externa webbplatser tab and continues there
  (setting `includeExternal`, on by default). Opening that tab and clicking the icon checks only external ads.

## [1.0.0] - 2026-11-24
First version, built from the design of `linkedin-job-filter` 1.10.8.

### Features
- Toolbar button on a Platsbanken results page: opens every ad without leaving the page (hidden same-origin iframe, or an
  inactive background tab; Platsbanken's own JSON endpoint as fallback), scores it against your resume and hard criteria with AI.
- AI providers: Claude (Anthropic), OpenAI, Google Gemini and TypeSafe Jev (TypeSafe, OpenRouter or Vercel AI Gateway key).
  Scoring requests run in parallel (max 5). The prompt knows the ads are often in Swedish ("krav" vs "meriterande").
- Matching ads: green badge, optional save with the site's heart button ("Spara annons", never un-saves).
- Ads that don't fit: red badge, dimmed or hidden (setting), since Platsbanken has no dismiss button.
- Rules without AI: keyword list (title, company, location, occupation) and commutable locations ("Distans" always passes).
- Skips ads already applied to ("Ansökt") or saved.
- Auto next page: presses "Nästa" until the last page or Stop.
- Score cache; badges from earlier runs are shown automatically on every results page.
- Draggable panel with summary, per-ad log with links, Stop / Run again, diagnostic when no ads are found.
