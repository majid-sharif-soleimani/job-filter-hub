// ---------------------------------------------------------------------------
// HARD CRITERIA (settings.criteria) — empty by default. Fill it in on the
// extension's options page. It is sent to the AI together with your resume and
// every job ad. Platsbanken ads are often in Swedish; the AI reads them either way.
// Write it in plain English, one rule per line. Example:
//
//   HARD RULES (a job that clearly breaks any of these must be rejected, score below 40):
//   - Target roles: backend or full-stack developer, mid or senior level; tech lead is fine.
//   - Reject: junior, intern, trainee, praktik roles; non-engineering roles (sales, HR, support...).
//   - Location: <your city> or places commutable from it; elsewhere only if fully remote (distans).
//   - Language: fluent Swedish must NOT be required ("flytande svenska krävs" = reject);
//     "Swedish is a plus" (meriterande) is fine.
//   - Security clearance (säkerhetsprövning) that requires Swedish citizenship: reject if you can't meet it.
//
//   TECHNOLOGY (not a hard rule):
//   - <your main stack> is the strongest fit, but do not reject a suitable role only because
//     it uses another language or framework. Count a technology as a real gap only if the ad
//     says it is required ("krav", "skall") ; "meriterande" (nice to have) is never disqualifying.
//
//   SCORING:
//   - 75–100 Strong · 55–74 Transition (learnable gap) · 40–54 Weak · below 40 Gap.
//
//   REASON: start with [Strong], [Transition], [Weak] or [Gap], then the main gap in a few words.
//
// Tips: keep it short and concrete; state what must cause a rejection; put rules that can be
// checked without AI (keywords, locations) in the fields below instead.
// ---------------------------------------------------------------------------

// Shared defaults (loaded by background.js via importScripts and by options.html)
const AFJF_DEFAULTS = {
  provider: "anthropic",
  models: {
    anthropic: "claude-haiku-5-5",
    openai: "gpt-5-mini",
    gemini: "gemini-2.5-flash",
    typesafe: "jev-latest" // or a pinned version such as "jev-1.13.0"
  },
  apiKeys: { anthropic: "", openai: "", gemini: "", typesafe: "" },
  threshold: 55, // minimum score to keep an ad; 55 also keeps "[Transition]" ads
  delaySec: 0, // pause after opening each ad
  // How each ad is opened: "iframe" = a hidden frame inside the results page (fast, invisible),
  // "tab" = a background tab that is closed again after reading. If both fail, the ad is read
  // from Platsbanken's own JSON endpoint as a last resort.
  openMode: "iframe",
  dryRun: false, // score and badge only: don't dim/hide and don't save
  saveMatches: true, // press Platsbanken's heart ("Spara annons") on matching ads (never un-saves)
  markRejected: "dim", // what to do with ads that don't fit: "dim" | "hide" | "none" (badge only)
  showPrevious: true, // show badges from earlier runs automatically when a results page is opened
  // "Externa webbplatser" tab: ads from other job sites, shown on Platsbanken only as a short summary.
  includeExternal: true, // with "Auto next page": after the last Platsbanken page, continue with the Externa tab
  readExternalSource: true, // read the full ad on the source site (needs the optional "all sites" permission)
  // Auto-reject keywords, comma separated, case-insensitive, searched in the card's title,
  // company, location and occupation (no AI call). Spaces are kept and matter:
  // "Java" also matches "JavaScript", " Java " only the word. Example: "Junior,Praktik,Trainee"
  blockKeywords: "",
  // Places you can commute to. An ad located anywhere else is rejected unless it is remote
  // (distans). Comma separated, whole-word match. Empty = rule disabled.
  // Example: "Stockholm, Solna, Sundbyberg, Kista"
  commuteLocations: "",
  resume: "", // stored only in this browser (chrome.storage.local)
  criteria: "" // see the guide above
};

async function afjfGetSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = Object.assign({}, AFJF_DEFAULTS, settings || {});
  s.models = Object.assign({}, AFJF_DEFAULTS.models, (settings || {}).models);
  s.apiKeys = Object.assign({}, AFJF_DEFAULTS.apiKeys, (settings || {}).apiKeys);
  return s;
}
