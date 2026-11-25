(() => {
  // Guard against double injection. After the extension is reloaded, the old copy of
  // this script stays on the page but is disconnected; let the new copy take over.
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  if (window.__jsjfAlive && window.__jsjfAlive()) return;
  window.__jsjfAlive = alive;
  document.getElementById("jsjf-panel")?.remove(); // panel left by a disconnected old copy

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let running = false;
  let stopRequested = false;
  let autoNextOn = false; // panel checkbox "Auto next page" (chrome.storage.local.autoNext)
  let hideRejected = true; // settings.hideRejected (also a panel checkbox)
  let lastDonePage = 0; // page number of the last finished run on this page (0 = none)

  // Remembered rejections (by AI, keyword or location). jobbsafari.se has no "not interested"
  // button, so the extension hides these cards itself on every visit.
  const rejectedIds = new Set();
  // Cached AI results, used to show badges again after a reload without a new AI call
  let scoreCacheView = {};

  chrome.storage.local.get(["autoNext", "settings", "rejectedIds", "scoreCache"]).then((d) => {
    autoNextOn = !!d.autoNext;
    hideRejected = d.settings?.hideRejected ?? true;
    for (const id of d.rejectedIds || []) rejectedIds.add(id);
    scoreCacheView = d.scoreCache || {};
    ui.syncChecks();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.rejectedIds && !(ch.rejectedIds.newValue || []).length) rejectedIds.clear(); // "Forget rejected" in options
    if (ch.scoreCache) scoreCacheView = ch.scoreCache.newValue || {};
    if (ch.settings) hideRejected = ch.settings.newValue?.hideRejected ?? true;
    ui.syncChecks();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "JSJF_TOGGLE") {
      if (running && !ui.visible()) {
        ui.show(); // panel was closed: just bring it back, keep running
        ui.status("Running…");
      } else if (running) {
        stopRequested = true;
        ui.status("Stopping after the current ad…");
      } else if (!getCards().length) {
        diagnose();
      } else {
        run().catch((e) => {
          ui.status("Error: " + e.message);
          finish();
        });
      }
      sendResponse({ ok: true });
    }
  });

  // ================= DOM helpers (jobbsafari.se, server-rendered, markup as of 2026-11) =================
  //   list:     /lediga-jobb (also /lediga-jobb/ort/<city>, /yrke/…, /kategori/…, /arbetsplats/distans), 30 ads per page
  //   card:     a link to the ad, href="/jobb/<title-slug>-<company-code>-<numeric id>", whose text is the card:
  //             [badges: Rekommenderat / Ansök utan CV / N dagar kvar] title, company, location, "20/11 – 31/12"
  //   pager:    numbered links ?page=N (full page loads, no SPA)
  // Class names are not relied on: cards are found by their link, fields by their text lines.
  // The ad page /jobb/<slug>-<id> is a full ad on jobbsafari.se, so it is fetched (no tab is opened).
  const LINK = 'a[href*="/jobb/"]';
  const ID_RE = /\/jobb\/[^/?#]*?-(\d{4,})\/?(?:[?#]|$)/;
  const BADGE_LINE = /^(rekommenderat|ansök utan cv|ny|nytt|new|sponsrad|annons|\d+\s+dagar? kvar|sista dagen idag|idag|igår)$/i;
  const DATE_LINE = /^\d{1,2}\/\d{1,2}(\s*[–-]\s*\d{1,2}\/\d{1,2})?$|^(publicerad|sista ansökningsdag)/i;

  const linkId = (a) => ((a?.getAttribute("href") || "").match(ID_RE) || [])[1] || null;

  function getCards() {
    const links = [...document.querySelectorAll(LINK)].filter((a) => linkId(a) && !a.closest("header, footer, nav"));
    const cards = links.map((a) => {
      // grow from the link to the largest element that still holds only this one ad link
      let el = a;
      const id = linkId(a);
      while (
        el.parentElement &&
        el.parentElement !== document.body &&
        !el.parentElement.matches("main, ul, ol") &&
        [...el.parentElement.querySelectorAll(LINK)].every((x) => linkId(x) === id || !linkId(x))
      )
        el = el.parentElement;
      return el;
    });
    return [...new Set(cards)].filter((c) => cardJobId(c));
  }

  function cardJobId(card) {
    if (card.matches?.(LINK) && linkId(card)) return linkId(card);
    for (const a of card.querySelectorAll(LINK)) if (linkId(a)) return linkId(a);
    return null;
  }

  function cardHref(card) {
    const a = card.matches?.(LINK) && linkId(card) ? card : [...card.querySelectorAll(LINK)].find(linkId);
    return a ? a.href : null;
  }

  function findCard(id) {
    return getCards().find((c) => cardJobId(c) === id) || null;
  }

  const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  // The card's text lines without the badges ("Rekommenderat", "Ansök utan CV", "5 dagar kvar")
  function cardLines(card) {
    const raw = (card.innerText || card.textContent || "").split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim());
    return raw.filter((l) => l && !BADGE_LINE.test(l) && l.length < 200);
  }
  function cardTitle(card) {
    const h = txt(card.querySelector("h1, h2, h3, h4, [class*='title' i]"));
    if (h) return h;
    return cardLines(card)[0] || cardJobId(card);
  }
  function cardCompany(card) {
    const c = txt(card.querySelector("[class*='company' i], [class*='employer' i], [class*='foretag' i]"));
    if (c) return c;
    const title = cardTitle(card);
    return cardLines(card).find((l) => l !== title && !DATE_LINE.test(l)) || "";
  }
  // Location = the line right before the date range ("Göteborg", "Stockholm", "Norge", "Distans")
  function cardLocation(card) {
    const l = txt(card.querySelector("[class*='location' i], [class*='ort' i], [class*='place' i]"));
    if (l) return l;
    const lines = cardLines(card);
    const d = lines.findIndex((x) => DATE_LINE.test(x));
    return d > 1 ? lines[d - 1] : "";
  }
  // Title, company, location (used by the keyword filter)
  const cardFields = (card) => [cardTitle(card), cardCompany(card), cardLocation(card)].filter(Boolean);
  const cardText = (card) => cardLines(card).join(" | ").slice(0, 600);

  // jobbsafari.se has no "saved" state on the cards that the extension can use
  const isSavedCard = () => false;

  // ================= Ad page (fetched, not opened) =================
  function jsonLdJob(doc) {
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const list = [].concat(data, data?.["@graph"] || []).flat();
        const job = list.find((x) => x && [].concat(x["@type"]).includes("JobPosting"));
        if (job) return job;
      } catch {}
    }
    return null;
  }
  const htmlToText = (html) => {
    const d = new DOMParser().parseFromString(
      String(html || "").replace(/<li[^>]*>/gi, "\n• ").replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, "\n"),
      "text/html"
    );
    return (d.documentElement.textContent || "").replace(/[ \t ]+/g, " ").replace(/ *\n[ \n]*/g, "\n").trim();
  };

  async function fetchDetail(id, url, attempt = 1) {
    const res = await fetch(url, { credentials: "include" });
    if (res.status === 429 && attempt < 3) {
      await sleep(3000 * attempt);
      return fetchDetail(id, url, attempt + 1);
    }
    if (!res.ok) throw new Error(`Ad page HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const ld = jsonLdJob(doc);
    const title = txt(doc.querySelector("main h1, h1")) || ld?.title || "";
    const company = ld?.hiringOrganization?.name || "";
    const where = [].concat(ld?.jobLocation || []).map((l) => [l?.address?.addressLocality, l?.address?.addressCountry?.name || l?.address?.addressCountry].filter(Boolean).join(", ")).filter(Boolean).join("; ");
    const facts = [
      where && "Location: " + where,
      ld?.jobLocationType && "Location type: " + ld.jobLocationType,
      ld?.employmentType && "Employment: " + [].concat(ld.employmentType).join(", "),
      ld?.datePosted && "Published: " + ld.datePosted,
      ld?.validThrough && "Apply by: " + ld.validThrough
    ].filter(Boolean).join("\n");

    doc.querySelectorAll("script, style, svg, noscript, template, header, footer, nav, aside, form").forEach((e) => e.remove());
    doc.querySelectorAll("p, li, br, h1, h2, h3, h4, div, dd, section, tr").forEach((e) => e.append("\n"));
    doc.querySelectorAll("dt").forEach((e) => e.append(": "));
    const clean = (el) => (el?.textContent || "").replace(/[ \t ]+/g, " ").replace(/ *\n[ \n]*/g, "\n").trim();
    // The full description: #description (target of "Visa hela jobbannonsen"), else the "Beskrivning" section
    let prose = clean(doc.querySelector("#description, [id*='description' i], [class*='description' i]"));
    if (prose.length < 200) {
      const h = [...doc.querySelectorAll("h2, h3")].find((x) => /^beskrivning$/i.test(txt(x)));
      if (h) {
        const parts = [];
        for (let el = h.nextElementSibling; el && !/^H[12]$/.test(el.tagName); el = el.nextElementSibling) parts.push(clean(el));
        if (parts.join("").length > prose.length) prose = parts.join("\n");
      }
    }
    if (prose.length < 200 && ld?.description) prose = htmlToText(ld.description);
    if (prose.length < 200) prose = clean(doc.querySelector("main") || doc.body); // unknown markup: take the whole page
    return { title, company, detailText: [facts, prose].filter(Boolean).join("\n\n").slice(0, 7000) };
  }

  // ================= Keyword filter =================
  // Not trimmed: spaces are significant (" Java " matches only the word). Case-insensitive substring.
  function parseBlockKeywords(str) {
    return String(str || "")
      .split(/[,\n]/)
      .filter((k) => k.trim() !== "")
      .map((k) => ({ k, low: k.toLowerCase() }));
  }
  function keywordHit(card, keywords) {
    if (!keywords.length) return null;
    for (const field of cardFields(card)) {
      const hay = (" " + field + " ").toLowerCase();
      for (const { k, low } of keywords) if (hay.includes(low)) return { keyword: k, field };
    }
    return null;
  }

  // Whole-word, trimmed (used for the location list)
  function parseKeywords(str) {
    return String(str || "")
      .split(/[,\n]/)
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => ({
        k,
        re: new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[^\\p{L}\\p{N}]|$)`, "iu")
      }));
  }

  // ================= Location rule =================
  // Card location looks like "Göteborg", "Stockholm", "Norge", "Distans".
  const REMOTE_RE = /\bremote\b|distans|på distans|zdalni|télétravail|teletrabajo|fernarbeit|homeoffice|\bwfh\b/i;
  const COUNTRY_ONLY = /^(sweden|sverige|europe|eu|european union|emea|nordics?|scandinavia|worldwide|anywhere)$/i;
  function locationProblem(card, places) {
    if (!places.length) return null; // rule disabled
    const loc = cardLocation(card);
    if (!loc) return null; // unknown: let the AI decide
    if (REMOTE_RE.test(loc)) return null;
    const place = loc.split("·")[0].replace(/\(.*?\)/g, "").trim();
    if (!place) return null;
    if (place.split(",").every((x) => COUNTRY_ONLY.test(x.trim()))) return null;
    if (places.some(({ re }) => re.test(place))) return null;
    return loc;
  }

  // ================= Rejected cards (hide or fade) =================
  function rememberRejected(id) {
    if (!id || rejectedIds.has(id)) return;
    rejectedIds.add(id);
    chrome.storage.local.set({ rejectedIds: [...rejectedIds].slice(-10000) }).catch(() => {});
  }
  function styleCard(card, id) {
    const rej = rejectedIds.has(id);
    const want = rej ? (hideRejected ? "none" : "") : "";
    if (card.style.display !== want) card.style.display = want;
    const op = rej && !hideRejected ? "0.45" : "";
    if (card.style.opacity !== op) card.style.opacity = op;
  }

  // ================= Next page =================
  // The pager is plain links (?page=N) that load a new page, so the run continues after the load:
  // the page number to resume is kept in sessionStorage (this tab only).
  const RESUME_KEY = "jsjf-resume-page";
  const pageParam = () => parseInt(new URL(location.href).searchParams.get("page") || "1", 10) || 1;
  function nextPageUrl() {
    const want = pageParam() + 1;
    const link = [...document.querySelectorAll('a[href*="page="]')].find((a) => {
      try {
        const u = new URL(a.href, location.href);
        return u.pathname === location.pathname && parseInt(u.searchParams.get("page"), 10) === want;
      } catch {
        return false;
      }
    });
    return link ? link.href : null;
  }

  async function goToNextPage(pageNo) {
    const url = nextPageUrl();
    if (!url) return { ok: false, why: "no link to the next page (last page?)" };
    try {
      sessionStorage.setItem(RESUME_KEY, String(pageNo + 1));
    } catch {}
    location.href = url;
    await sleep(20000); // the page is replaced before this ends
    try {
      sessionStorage.removeItem(RESUME_KEY);
    } catch {}
    return { ok: false, why: "the next page did not load" };
  }

  // Run started by "Auto next page" on the previous page: continue here
  (async () => {
    let resume = 0;
    try {
      resume = parseInt(sessionStorage.getItem(RESUME_KEY) || "0", 10);
      sessionStorage.removeItem(RESUME_KEY);
    } catch {}
    if (!resume) return;
    const { autoNext } = await chrome.storage.local.get("autoNext");
    if (!autoNext) return;
    for (let i = 0; i < 20 && !getCards().length; i++) await sleep(500);
    if (!getCards().length || running) return;
    run(resume).catch((e) => {
      ui.status("Error: " + e.message);
      finish();
    });
  })();

  // ================= Cache =================
  async function getCache() {
    const { scoreCache } = await chrome.storage.local.get("scoreCache");
    return scoreCache || {};
  }
  async function putCache(id, result) {
    const c = await getCache();
    c[id] = { ...result, ts: Date.now() };
    await chrome.storage.local.set({ scoreCache: c });
  }

  // ================= Main loop =================
  async function run(pageNo = 1) {
    const { settings } = await chrome.storage.local.get("settings");
    const threshold = settings?.threshold ?? 55;
    const delayMs = (settings?.delaySec ?? 0.5) * 1000;
    const dryRun = !!settings?.dryRun;
    const MAX_PARALLEL = 5; // AI requests in flight at once

    running = true;
    stopRequested = false;
    ui.show();
    ui.setRunning(true);
    if (pageNo === 1) ui.reset();
    else ui.log(`—— Page ${pageNo} ——`, "", "ok");
    ui.status((pageNo > 1 ? `Page ${pageNo} · ` : "") + (dryRun ? "Running (dry run: nothing will be hidden)…" : "Running…"));

    const stats = { match: 0, saved: 0, rejected: 0, keyword: 0, location: 0, skipped: 0, errors: 0 };
    const keywords = parseBlockKeywords(settings?.blockKeywords);
    const places = parseKeywords(settings?.commuteLocations);
    const cache = await getCache();
    const inFlight = new Set();
    const processed = new Set();
    let done = 0;
    let total = 0;
    const refreshStatus = (extra = "") =>
      ui.status(`${pageNo > 1 ? `Page ${pageNo} · ` : ""}Checked ${done}/${total} · scoring ${inFlight.size}${extra ? " · " + extra : ""}`);

    // reject = remember + hide/fade (not in dry run)
    function reject(id) {
      if (dryRun) return;
      rememberRejected(id);
      const c = findCard(id);
      if (c) styleCard(c, id);
    }

    function applyResult(id, title, result) {
      const fit = result.decision === "match" && result.score >= threshold;
      badge(id, result, fit);
      if (fit) {
        stats.match++;
        ui.log(`✅ ${result.score} · ${title}`, result.reason, "ok");
      } else {
        stats.rejected++;
        reject(id);
        ui.log(`❌ ${result.score} · ${title}`, result.reason, "bad");
      }
      ui.stats(stats, dryRun);
    }

    function handleError(id, title, e) {
      stats.errors++;
      badge(id, { label: "⚠ Error (not checked)", kind: "warn", reason: e.message }, false);
      ui.log(`⚠️ error · ${title}`, e.message, "warn");
      if (/HTTP 40[13]/.test(e.message) && !/Ad page/.test(e.message)) {
        ui.status("API key rejected. Check the extension options.");
        stopRequested = true;
      }
      ui.stats(stats, dryRun);
    }

    // Two passes, in case the list re-rendered while we worked
    for (let pass = 0; pass < 2 && !stopRequested; pass++) {
      const cards = getCards().filter((c) => !processed.has(cardJobId(c)));
      if (!cards.length) break;
      total += cards.length;

      for (const card0 of cards) {
        if (stopRequested) break;
        const id = cardJobId(card0);
        processed.add(id);
        done++;
        chrome.runtime.sendMessage({ type: "JSJF_STATE", running: true, progress: String(done) }).catch(() => {});
        const card = findCard(id) || card0;
        const title = cardTitle(card);

        if (isSavedCard(card)) {
          badge(id, { label: "♥ Saved (skipped)", kind: "skip", reason: "Already saved, not checked again" }, false);
          stats.skipped++;
          ui.stats(stats, dryRun);
          continue;
        }

        // Rejected before (remembered or cached): hide again, no AI call
        const cached = cache[id];
        if (rejectedIds.has(id) || (cached && !(cached.decision === "match" && cached.score >= threshold))) {
          const why = cached?.reason || "previously rejected";
          badge(id, { label: "✕ Rejected before" + (cached ? ` · AI ${cached.score}` : ""), reason: why }, false);
          reject(id);
          stats.rejected++;
          ui.log(`✕ rejected before · ${title}`, why, "bad");
          ui.stats(stats, dryRun);
          continue;
        }

        const hit = keywordHit(card, keywords);
        if (hit) {
          badge(id, { label: `🚫 Keyword: ${hit.keyword.trim()}`, reason: `Keyword "${hit.keyword}" found in "${hit.field}"` }, false);
          reject(id);
          stats.keyword++;
          ui.log(`🚫 keyword "${hit.keyword}" · ${title}`, hit.field, "bad");
          ui.stats(stats, dryRun);
          continue;
        }

        const badLoc = locationProblem(card, places);
        if (badLoc) {
          badge(id, { label: `📍 Location: ${badLoc}`, reason: `Not in your commutable places and not remote: ${badLoc}` }, false);
          reject(id);
          stats.location++;
          ui.log(`📍 not commutable/remote · ${title}`, badLoc, "bad");
          ui.stats(stats, dryRun);
          continue;
        }

        if (cached) {
          applyResult(id, title, cached);
          continue;
        }

        while (inFlight.size >= MAX_PARALLEL && !stopRequested) await Promise.race(inFlight);
        if (stopRequested) break;

        let job;
        try {
          refreshStatus("reading ad…");
          badge(id, { label: "… checking", kind: "skip", reason: "" }, false);
          const d = await fetchDetail(id, cardHref(card));
          job = { title: d.title || title, company: d.company || cardCompany(card), cardText: cardText(card), detailText: d.detailText };
        } catch (e) {
          handleError(id, title, e);
          continue;
        }

        const p = chrome.runtime
          .sendMessage({ type: "JSJF_SCORE", job })
          .then(async (resp) => {
            if (!resp?.ok) throw new Error(resp?.error || "No response from background");
            await putCache(id, resp.result);
            applyResult(id, job.title, resp.result);
          })
          .catch((e) => handleError(id, job.title, e))
          .finally(() => {
            inFlight.delete(p);
            refreshStatus();
          });
        inFlight.add(p);
        refreshStatus();
        if (delayMs) await sleep(delayMs);
      }
    }

    refreshStatus("waiting for the last scores…");
    await Promise.allSettled([...inFlight]);

    ui.status(stopRequested ? "Stopped." : `Done for this page (${done} ads).` + (autoNextOn ? "" : ' Tick "Auto next page" to continue.'));
    ui.stats(stats, dryRun);
    lastDonePage = stopRequested ? 0 : pageNo;

    if (!stopRequested && autoNextOn) {
      ui.status(`Page ${pageNo} done · going to the next page…`);
      const res = await goToNextPage(pageNo);
      lastDonePage = 0;
      if (res.ok && !stopRequested && autoNextOn) {
        finish();
        return run(pageNo + 1);
      }
      if (!res.ok) ui.log(`⏹ No next page after page ${pageNo}`, res.why, "warn");
      ui.status(stopRequested || res.ok ? "Stopped." : `Done · no next page after page ${pageNo} (${res.why}).`);
    }
    finish();
  }

  // "Auto next page" ticked after a page finished: go on right away
  async function continueWithNextPage() {
    const pageNo = lastDonePage;
    lastDonePage = 0;
    running = true;
    ui.setRunning(true);
    ui.status(`Page ${pageNo} done · going to the next page…`);
    const res = await goToNextPage(pageNo);
    running = false;
    if (res.ok && !stopRequested && autoNextOn) return run(pageNo + 1).catch((e) => { ui.status("Error: " + e.message); finish(); });
    if (!res.ok) ui.log(`⏹ No next page after page ${pageNo}`, res.why, "warn");
    ui.status(res.ok ? "Stopped." : `Done · no next page after page ${pageNo} (${res.why}).`);
    finish();
  }

  function finish() {
    running = false;
    stopRequested = false;
    ui.setRunning(false);
    chrome.runtime.sendMessage({ type: "JSJF_STATE", running: false }).catch(() => {});
  }

  function diagnose() {
    const info = {
      url: location.href,
      adLinks: [...document.querySelectorAll(LINK)].filter(linkId).length,
      cards: getCards().length,
      nextPage: nextPageUrl(),
      sampleHrefs: [...document.querySelectorAll("main a[href]")].map((a) => a.getAttribute("href")).slice(0, 15),
      sampleClasses: [...new Set([...document.querySelectorAll("main [class]")].map((e) => e.className))].slice(0, 25)
    };
    console.log("[JSJF] diagnostic", info);
    ui.show();
    ui.reset();
    ui.status(/^\/lediga-jobb/.test(location.pathname) ? "No job ads found on this page. Diagnostic (send this to Claude):" : "Open a job list first (jobbsafari.se/lediga-jobb).");
    ui.log("Diagnostic", JSON.stringify(info), "warn");
  }

  // ================= Badges =================
  // Badges and hiding are re-applied every second (cheap, and safe if the list changes).
  const badges = new Map(); // id -> {label, kind, reason}
  const BADGE_COLORS = { ok: "#1e8e3e", bad: "#c5221f", skip: "#6b7280", warn: "#b06000" };

  function badge(id, result, fit) {
    let label = result.label;
    if (!label) {
      const tag = (String(result.reason || "").match(/^\s*\[(\w+)\]/) || [])[1];
      label = `${fit ? "✓" : "✕"} AI ${result.score}${tag ? " · " + tag : ""}`;
    }
    badges.set(id, { label, kind: result.kind || (fit ? "ok" : "bad"), reason: result.reason || "" });
    const c = findCard(id);
    if (c) applyBadge(c, id);
  }

  function applyBadge(card, id) {
    const info = badges.get(id);
    if (!info) return;
    const existing = card.querySelector(":scope > .jsjf-badge");
    if (existing && existing.textContent === info.label && existing.title === info.reason) return;
    existing?.remove();
    const b = document.createElement("div");
    b.className = "jsjf-badge";
    b.textContent = info.label;
    b.title = info.reason;
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    Object.assign(b.style, {
      position: "absolute",
      right: "8px",
      top: "8px",
      maxWidth: "45%",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      zIndex: 5,
      padding: "2px 8px",
      borderRadius: "10px",
      font: "600 12px system-ui, sans-serif",
      color: "#fff",
      background: BADGE_COLORS[info.kind] || BADGE_COLORS.bad,
      cursor: "help"
    });
    card.appendChild(b);
  }

  // Every second: badges (also from the cache after a reload) and hiding of remembered rejections
  setInterval(() => {
    let threshold = 55;
    for (const card of getCards()) {
      const id = cardJobId(card);
      if (!badges.has(id)) {
        const c = scoreCacheView[id];
        if (c) badges.set(id, { label: `${c.decision === "match" ? "✓" : "✕"} AI ${c.score}`, kind: c.decision === "match" ? "ok" : "bad", reason: c.reason || "" });
        else if (rejectedIds.has(id)) badges.set(id, { label: "✕ Rejected before", kind: "bad", reason: "Rejected in an earlier run" });
      }
      applyBadge(card, id);
      styleCard(card, id);
    }
    ui.hiddenCount(getCards().filter((c) => rejectedIds.has(cardJobId(c))).length);
  }, 1000);

  // ================= Floating panel =================
  const ui = (() => {
    let root, statusEl, statsEl, logEl, autoNextEl, hideEl, hiddenEl;
    const history = [];
    function build() {
      root = document.createElement("div");
      root.id = "jsjf-panel";
      root.innerHTML = `
        <div data-r="handle" title="Drag to move" style="display:flex;align-items:center;gap:8px;margin:-10px -12px 6px;padding:8px 12px;cursor:move;user-select:none;background:#ecfdf5;border-radius:10px 10px 0 0;border-bottom:1px solid #d1e7dd">
          <strong style="flex:1">⠿ Jobbsafari Job Filter</strong>
          <button data-a="details" style="cursor:pointer" title="Show/hide per-ad report">Details ▾</button>
          <button data-a="rerun" style="cursor:pointer;display:none" title="Run again on this page">↻ Run again</button>
          <button data-a="stop" style="cursor:pointer">Stop</button>
          <button data-a="close" style="cursor:pointer">✕</button>
        </div>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none"><input type="checkbox" data-a="autonext"> Auto next page <span style="color:#777">(until Stop)</span></label>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:4px;cursor:pointer;user-select:none"><input type="checkbox" data-a="hide"> Hide rejected <span data-r="hidden" style="color:#777"></span></label>
        <div data-r="status" style="margin-bottom:4px"></div>
        <div data-r="stats" style="margin-bottom:6px;color:#555"></div>
        <div data-r="log" style="display:none;max-height:420px;overflow:auto;border-top:1px solid #ddd;padding-top:4px"></div>`;
      Object.assign(root.style, {
        position: "fixed", left: "16px", bottom: "16px", width: "340px", zIndex: 2147483647,
        background: "#fff", color: "#222", border: "1px solid #ccc", borderRadius: "10px",
        boxShadow: "0 6px 24px rgba(0,0,0,.18)", padding: "10px 12px", font: "13px/1.4 system-ui, sans-serif"
      });
      statusEl = root.querySelector('[data-r="status"]');
      statsEl = root.querySelector('[data-r="stats"]');
      logEl = root.querySelector('[data-r="log"]');
      hiddenEl = root.querySelector('[data-r="hidden"]');
      autoNextEl = root.querySelector('[data-a="autonext"]');
      autoNextEl.onchange = () => {
        autoNextOn = autoNextEl.checked;
        chrome.storage.local.set({ autoNext: autoNextOn }).catch(() => {});
        if (autoNextOn && !running && lastDonePage > 0) continueWithNextPage();
      };
      hideEl = root.querySelector('[data-a="hide"]');
      hideEl.onchange = async () => {
        hideRejected = hideEl.checked;
        const { settings } = await chrome.storage.local.get("settings");
        await chrome.storage.local.set({ settings: { ...(settings || {}), hideRejected } });
      };
      syncChecks();

      const detailsBtn = root.querySelector('[data-a="details"]');
      const setExpanded = (on) => {
        logEl.style.display = on ? "block" : "none";
        root.style.width = on ? "480px" : "340px";
        detailsBtn.textContent = on ? "Details ▴" : "Details ▾";
        try { localStorage.setItem("jsjf-panel-expanded", on ? "1" : "0"); } catch {}
        const r = root.getBoundingClientRect();
        if (r.right > window.innerWidth) root.style.left = Math.max(0, window.innerWidth - r.width - 8) + "px";
        if (r.bottom > window.innerHeight && root.style.top) root.style.top = Math.max(0, window.innerHeight - r.height - 8) + "px";
      };
      let expanded = false;
      try { expanded = localStorage.getItem("jsjf-panel-expanded") === "1"; } catch {}
      detailsBtn.onclick = () => setExpanded((expanded = !expanded));
      root.querySelector('[data-a="rerun"]').onclick = () => {
        if (running) return;
        if (!getCards().length) return status("No ads found on this page.");
        run().catch((e) => { status("Error: " + e.message); finish(); });
      };
      root.querySelector('[data-a="stop"]').onclick = () => {
        if (running) {
          stopRequested = true;
          status("Stopping after the current ad…");
        }
      };
      root.querySelector('[data-a="close"]').onclick = () => {
        root.remove();
        root = null;
      };
      document.body.appendChild(root);
      for (const h of history) render(...h);
      makeDraggable(root, root.querySelector('[data-r="handle"]'));
      setExpanded(expanded);
    }

    function makeDraggable(panel, handle) {
      const KEY = "jsjf-panel-pos";
      const place = (x, y) => {
        x = Math.max(0, Math.min(x, window.innerWidth - panel.offsetWidth));
        y = Math.max(0, Math.min(y, window.innerHeight - 40));
        Object.assign(panel.style, { left: x + "px", top: y + "px", bottom: "auto", right: "auto" });
      };
      try {
        const pos = JSON.parse(localStorage.getItem(KEY) || "null");
        if (pos) place(pos.x, pos.y);
      } catch {}
      handle.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        e.preventDefault();
        const r = panel.getBoundingClientRect();
        const dx = e.clientX - r.left;
        const dy = e.clientY - r.top;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          try {
            const r2 = panel.getBoundingClientRect();
            localStorage.setItem(KEY, JSON.stringify({ x: r2.left, y: r2.top }));
          } catch {}
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      });
    }

    function show() {
      if (!root || !document.body.contains(root)) build();
      setRunning(running);
    }
    function setRunning(on) {
      if (!root) return;
      root.querySelector('[data-a="rerun"]').style.display = on ? "none" : "";
      root.querySelector('[data-a="stop"]').style.display = on ? "" : "none";
    }
    const visible = () => !!root && document.body.contains(root);
    function reset() {
      history.length = 0;
      if (logEl) logEl.innerHTML = "";
      if (statsEl) statsEl.textContent = "";
    }
    function status(t) {
      if (statusEl) statusEl.textContent = t;
    }
    function stats(s, dry) {
      if (statsEl)
        statsEl.textContent = `Match: ${s.match} · ${dry ? "Would reject" : "Rejected"} by AI: ${s.rejected} · by keyword: ${s.keyword} · by location: ${s.location} · Errors: ${s.errors}`;
    }
    function log(head, detail, kind) {
      history.push([head, detail, kind]);
      if (history.length > 300) history.shift();
      render(head, detail, kind);
    }
    function render(head, detail, kind) {
      if (!logEl) return;
      const d = document.createElement("div");
      d.style.margin = "4px 0";
      d.style.color = kind === "ok" ? "#1e8e3e" : kind === "bad" ? "#c5221f" : "#b06000";
      d.innerHTML = `<div style="font-weight:600"></div><div style="color:#555;font-size:12px"></div>`;
      d.children[0].textContent = head;
      d.children[1].textContent = detail || "";
      logEl.prepend(d);
    }
    function syncChecks() {
      if (autoNextEl) autoNextEl.checked = autoNextOn;
      if (hideEl) hideEl.checked = hideRejected;
    }
    function hiddenCount(n) {
      if (hiddenEl) hiddenEl.textContent = n ? `(${n} on this page)` : "";
    }
    return { show, visible, setRunning, reset, status, stats, log, syncChecks, hiddenCount };
  })();
})();
