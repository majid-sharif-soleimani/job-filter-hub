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
  if (window.__cjfAlive && window.__cjfAlive()) return;
  window.__cjfAlive = alive;
  document.getElementById("cjf-panel")?.remove(); // panel left by a disconnected old copy

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let running = false;
  let stopRequested = false;
  let autoNextOn = false; // panel checkbox "Auto next page" (chrome.storage.local.autoNext)
  let hideRejected = true; // settings.hideRejected (also a panel checkbox)
  let lastDonePage = 0; // page number of the last finished run on this page (0 = none)

  // Remembered rejections (by AI, keyword or location). consultant.dev has no "not interested"
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
    if (msg.type === "CJF_TOGGLE") {
      if (running && !ui.visible()) {
        ui.show(); // panel was closed: just bring it back, keep running
        ui.status("Running…");
      } else if (running) {
        stopRequested = true;
        ui.status("Stopping after the current assignment…");
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

  // ================= DOM helpers (consultant.dev, Nuxt/Vue, markup as of 2026-11) =================
  //   card:     article.assignment-row
  //   link:     a.assignment-row__open[href="/assignments/<id>"]   (data-testid="srp-card-<id>")
  //   title:    h3.job-title
  //   company:  span.assignment-row__company, followed by a span "City, Region · Hybrid"
  //   skills:   .assignment-row__skills > span
  //   save:     button.assignment-row__save[aria-pressed="true|false"]   (heart)
  //   pager:    .srp-pager > button.srp-page-btn ("Previous 1 2 … Next"); SPA, URL gets &page=N
  // The assignment page /assignments/<id> is server-rendered, so it is fetched (no tab is opened).
  const CARD = "article.assignment-row";
  const LINK = 'a[href*="/assignments/"]';
  const ID_RE = /\/assignments\/([A-Za-z0-9_-]{6,})/;

  function getCards() {
    let cards = [...document.querySelectorAll(CARD)];
    if (!cards.length) {
      // fallback: any element around an assignment link that holds only that one link
      cards = [...document.querySelectorAll(LINK)].map((a) => {
        let el = a;
        while (el.parentElement && el.parentElement !== document.body && el.parentElement.querySelectorAll(LINK).length === 1) el = el.parentElement;
        return el;
      });
    }
    return [...new Set(cards)].filter((c) => cardJobId(c));
  }

  function cardJobId(card) {
    const a = card.matches?.(LINK) ? card : card.querySelector(LINK);
    const m = (a?.getAttribute("href") || "").match(ID_RE);
    return m ? m[1] : null;
  }

  function findCard(id) {
    const a = document.querySelector(`a[href="/assignments/${id}"], a[href$="/assignments/${id}"]`);
    if (!a) return null;
    return a.closest(CARD) || getCards().find((c) => cardJobId(c) === id) || null;
  }

  const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const cardTitle = (card) => txt(card.querySelector(".job-title, h3, h2")) || cardJobId(card);
  const cardCompany = (card) => txt(card.querySelector(".assignment-row__company"));
  function cardLocation(card) {
    const box = card.querySelector(".assignment-row__location");
    if (!box) return "";
    // "Company | Location · Work model | [rate] | [Closes in N days]": the location is the first span after
    // the company that is not a rate or a closing notice
    const spans = [...box.children].filter(
      (s) =>
        txt(s) &&
        !s.classList.contains("assignment-row__company") &&
        !/closing/.test(s.className) &&
        !/\d.*(USD|EUR|GBP|SEK|NOK|DKK|CHF|PLN|AUD|CAD|INR|SGD|\$|€|£|kr)|\/(h|hour|day|year|month)\b|closes in/i.test(txt(s))
    );
    return txt(spans[0]);
  }
  const cardSkills = (card) =>
    [...card.querySelectorAll(".assignment-row__skills > span:not(.assignment-row__skills-more)")].map(txt).filter(Boolean);
  // Title, company, location (used by the keyword filter)
  const cardFields = (card) => [cardTitle(card), cardCompany(card), cardLocation(card)].filter(Boolean);
  function cardText(card) {
    const closing = txt(card.querySelector(".assignment-row__closing"));
    const snippet = txt(card.querySelector(".assignment-row__snippet"));
    const where = txt(card.querySelector(".assignment-row__location")); // company, location, rate, closing
    return [where || cardCompany(card), cardSkills(card).join(", "), where.includes(closing) ? "" : closing, snippet].filter(Boolean).join(" | ").slice(0, 600);
  }

  const saveButton = (card) => card.querySelector("button.assignment-row__save, button[aria-label^='Save' i]");
  const isSavedCard = (card) => saveButton(card)?.getAttribute("aria-pressed") === "true";

  // Signed out = the header shows Sign in / Sign up links. Saving needs an account.
  const signedOut = () => !!document.querySelector('header a[href^="/sign-in"], header a[href^="/sign-up"], nav a[href^="/sign-in"]');

  // ================= Assignment page (fetched, not opened) =================
  async function fetchDetail(id, attempt = 1) {
    const res = await fetch(`/assignments/${id}`, { credentials: "include" });
    if (res.status === 429 && attempt < 3) {
      await sleep(3000 * attempt);
      return fetchDetail(id, attempt + 1);
    }
    if (!res.ok) throw new Error(`Assignment page HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    doc.querySelectorAll("script, style, svg, noscript, template, .asct, .jd-actions, .jd-more-menu, .jd-back").forEach((e) => e.remove());
    // keep line breaks between blocks (a parsed document has no layout, so innerText = textContent)
    doc.querySelectorAll("p, li, br, h1, h2, h3, h4, div, dd, section, tr").forEach((e) => e.append("\n"));
    doc.querySelectorAll("dt").forEach((e) => e.append(": "));
    const root = doc.querySelector(".assignment-detail__main") || doc.querySelector("main") || doc.body;
    const clean = (el) => (el?.textContent || "").replace(/[ \t ]+/g, " ").replace(/ *\n[ \n]*/g, "\n").trim();
    const title = txt(root.querySelector(".jd-title, h1"));
    const company = txt(root.querySelector(".jd-co-name"));
    const meta = [txt(root.querySelector(".jd-co-src")), txt(root.querySelector(".jd-co-posted"))].filter(Boolean).join(" · ");
    const facts = clean(root.querySelector(".jd-facts"));
    const skills = [...root.querySelectorAll(".jd-skills__list li")].map(txt).filter(Boolean).join(", ");
    const prose = clean(root.querySelector(".jd-prose, .assignment-prose"));
    let detail = [meta, facts, skills && "Skills: " + skills, prose].filter(Boolean).join("\n\n");
    if (detail.length < 80) detail = clean(root); // unknown markup: take the whole main area
    return { title, company, detailText: detail.slice(0, 7000) };
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
  // Card location looks like "Leeds, West Yorkshire · Hybrid", "Portugal · Remote", "Singapore".
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

  // ================= Save matching (heart button on the card) =================
  async function saveCard(id) {
    const card = findCard(id);
    const btn = card && saveButton(card);
    if (!btn) return "missing";
    if (btn.getAttribute("aria-pressed") === "true") return "already";
    btn.click();
    await sleep(900);
    return btn.isConnected && btn.getAttribute("aria-pressed") === "true" ? "saved" : "unsure";
  }

  // ================= Next page =================
  const findNextButton = () =>
    [...document.querySelectorAll(".srp-pager button, .srp-page-btn, nav[aria-label*='pagination' i] button, nav[aria-label*='pagination' i] a")].find((b) =>
      /^(next|nästa|›|»)$/i.test(txt(b)) || /^next( page)?$/i.test(b.getAttribute("aria-label") || "")
    ) || null;
  const pageParam = () => new URL(location.href).searchParams.get("page") || "1";
  const pageSignature = () => pageParam() + "|" + getCards().slice(0, 3).map(cardJobId).join(",");

  async function goToNextPage() {
    const next = findNextButton();
    if (!next) return { ok: false, why: "Next button not found (last page?)" };
    if (next.disabled || next.getAttribute("aria-disabled") === "true") return { ok: false, why: "Next button is disabled (last page)" };
    const before = pageSignature();
    next.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(400);
      if (pageSignature() !== before && getCards().length) {
        await sleep(800); // let the new page settle
        window.scrollTo(0, 0);
        return { ok: true };
      }
    }
    return { ok: false, why: `clicked Next but the page did not change (page=${pageParam()})` };
  }

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
    const doSave = !!settings?.saveMatches;
    const MAX_PARALLEL = 5; // AI requests in flight at once

    running = true;
    stopRequested = false;
    ui.show();
    ui.setRunning(true);
    if (pageNo === 1) ui.reset();
    else ui.log(`—— Page ${pageNo} ——`, "", "ok");
    ui.status((pageNo > 1 ? `Page ${pageNo} · ` : "") + (dryRun ? "Running (dry run: nothing will be hidden or saved)…" : "Running…"));

    const stats = { match: 0, saved: 0, rejected: 0, keyword: 0, location: 0, skipped: 0, errors: 0 };
    const keywords = parseBlockKeywords(settings?.blockKeywords);
    const places = parseKeywords(settings?.commuteLocations);
    const cache = await getCache();
    const toSave = new Map();
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
        if (doSave) toSave.set(id, title);
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
      if (/HTTP 40[13]/.test(e.message) && !/Assignment page/.test(e.message)) {
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
        chrome.runtime.sendMessage({ type: "CJF_STATE", running: true, progress: String(done) }).catch(() => {});
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
          refreshStatus("reading assignment…");
          badge(id, { label: "… checking", kind: "skip", reason: "" }, false);
          const d = await fetchDetail(id);
          job = { title: d.title || title, company: d.company || cardCompany(card), cardText: cardText(card), detailText: d.detailText };
        } catch (e) {
          handleError(id, title, e);
          continue;
        }

        const p = chrome.runtime
          .sendMessage({ type: "CJF_SCORE", job })
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

    if (toSave.size && !dryRun && !stopRequested) {
      if (signedOut()) {
        ui.log(`♡ ${toSave.size} match(es) not saved`, "You are not signed in to consultant.dev", "warn");
      } else {
        let n = 0;
        for (const [id, title] of toSave) {
          if (stopRequested) break;
          ui.status(`Saving matches… ${++n}/${toSave.size}`);
          const r = await saveCard(id);
          if (r === "saved") stats.saved++;
          ui.log(r === "saved" ? `♥ saved · ${title}` : r === "already" ? `♥ already saved · ${title}` : `⚠️ could not save · ${title}`, "", r === "saved" || r === "already" ? "ok" : "warn");
          ui.stats(stats, dryRun);
        }
      }
    }

    ui.status(stopRequested ? "Stopped." : `Done for this page (${done} assignments).` + (autoNextOn ? "" : ' Tick "Auto next page" to continue.'));
    ui.stats(stats, dryRun);
    lastDonePage = stopRequested ? 0 : pageNo;

    if (!stopRequested && autoNextOn) {
      ui.status(`Page ${pageNo} done · going to the next page…`);
      const res = await goToNextPage();
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
    const res = await goToNextPage();
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
    chrome.runtime.sendMessage({ type: "CJF_STATE", running: false }).catch(() => {});
  }

  function diagnose() {
    const info = {
      url: location.href,
      articles: document.querySelectorAll("article").length,
      assignmentRows: document.querySelectorAll(CARD).length,
      assignmentLinks: document.querySelectorAll(LINK).length,
      pager: !!findNextButton(),
      sampleClasses: [...new Set([...document.querySelectorAll("main [class]")].map((e) => e.className))].slice(0, 25)
    };
    console.log("[CJF] diagnostic", info);
    ui.show();
    ui.reset();
    ui.status(/\/search/.test(location.pathname) ? "No assignments found on this page. Diagnostic (send this to Claude):" : "Open a search results page (consultant.dev/search?q=…) first.");
    ui.log("Diagnostic", JSON.stringify(info), "warn");
  }

  // ================= Badges =================
  // The list is re-rendered by Vue (page changes, filters), so badges and hiding are re-applied every second.
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
    const existing = card.querySelector(":scope > .cjf-badge");
    if (existing && existing.textContent === info.label && existing.title === info.reason) return;
    existing?.remove();
    const b = document.createElement("div");
    b.className = "cjf-badge";
    b.textContent = info.label;
    b.title = info.reason;
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    Object.assign(b.style, {
      position: "absolute",
      right: "56px",
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
    ui.hiddenCount([...document.querySelectorAll(CARD)].filter((c) => rejectedIds.has(cardJobId(c))).length);
  }, 1000);

  // ================= Floating panel =================
  const ui = (() => {
    let root, statusEl, statsEl, logEl, autoNextEl, hideEl, hiddenEl;
    const history = [];
    function build() {
      root = document.createElement("div");
      root.id = "cjf-panel";
      root.innerHTML = `
        <div data-r="handle" title="Drag to move" style="display:flex;align-items:center;gap:8px;margin:-10px -12px 6px;padding:8px 12px;cursor:move;user-select:none;background:#ecfdf5;border-radius:10px 10px 0 0;border-bottom:1px solid #d1e7dd">
          <strong style="flex:1">⠿ Consultant Job Filter</strong>
          <button data-a="details" style="cursor:pointer" title="Show/hide per-assignment report">Details ▾</button>
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
        try { localStorage.setItem("cjf-panel-expanded", on ? "1" : "0"); } catch {}
        const r = root.getBoundingClientRect();
        if (r.right > window.innerWidth) root.style.left = Math.max(0, window.innerWidth - r.width - 8) + "px";
        if (r.bottom > window.innerHeight && root.style.top) root.style.top = Math.max(0, window.innerHeight - r.height - 8) + "px";
      };
      let expanded = false;
      try { expanded = localStorage.getItem("cjf-panel-expanded") === "1"; } catch {}
      detailsBtn.onclick = () => setExpanded((expanded = !expanded));
      root.querySelector('[data-a="rerun"]').onclick = () => {
        if (running) return;
        if (!getCards().length) return status("No assignments found on this page.");
        run().catch((e) => { status("Error: " + e.message); finish(); });
      };
      root.querySelector('[data-a="stop"]').onclick = () => {
        if (running) {
          stopRequested = true;
          status("Stopping after the current assignment…");
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
      const KEY = "cjf-panel-pos";
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
        statsEl.textContent = `Match: ${s.match} (♥ saved now: ${s.saved}) · ${dry ? "Would reject" : "Rejected"} by AI: ${s.rejected} · by keyword: ${s.keyword} · by location: ${s.location} · Skipped (saved): ${s.skipped} · Errors: ${s.errors}`;
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
