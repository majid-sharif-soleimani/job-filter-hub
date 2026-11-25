// The sub-extensions bundled in this hub. Each one lives unchanged in extensions/<id>/.
// - prefix: the message-type prefix the sub-extension uses (LJF_SCORE, IJF_TOGGLE, ...)
// - match:  pages where the toolbar button belongs to this sub-extension
// Used by the background router, the hub page and tools/build.mjs (keep it plain data).
var JF_SUBS = [
  {
    id: "linkedin",
    name: "LinkedIn",
    prefix: "LJF_",
    site: "https://www.linkedin.com/jobs/search/",
    match: "^https://([a-z0-9-]+\\.)*linkedin\\.com/"
  },
  {
    id: "indeed",
    name: "Indeed",
    prefix: "IJF_",
    site: "https://www.indeed.com/",
    match: "^https://([a-z0-9-]+\\.)*indeed\\.com/"
  },
  {
    id: "consultant",
    name: "consultant.dev",
    prefix: "CJF_",
    site: "https://consultant.dev/",
    match: "^https://(www\\.)?consultant\\.dev/"
  },
  {
    id: "platsbanken",
    name: "Platsbanken (Arbetsförmedlingen)",
    prefix: "AFJF_",
    site: "https://arbetsformedlingen.se/platsbanken/annonser",
    match: "^https://(www\\.)?arbetsformedlingen\\.se/"
  },
  {
    id: "jobbsafari",
    name: "Jobbsafari",
    prefix: "JSJF_",
    site: "https://jobbsafari.se/lediga-jobb",
    match: "^https://(www\\.)?jobbsafari\\.se/"
  }
];

if (typeof module !== "undefined") module.exports = JF_SUBS;
