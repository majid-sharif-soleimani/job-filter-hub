# Changelog

All notable changes. Newest first. Versions match `manifest.json` → `version`.

## [1.0.0] - 2026-11-24
### Added
- First version, ported from linkedin-job-filter 1.10.8 for consultant.dev search pages.
- Assignment pages are fetched in the background (server-rendered), so no tab is opened per assignment.
- Rejected assignments are remembered and hidden on the page (or faded with "Hide rejected" off), since the site has no dismiss action.
- Keyword and commutable-location rules (no AI), score cache, Auto next page, optional Save ♡ of matches when signed in.
