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
  if (window.__afjfAlive && window.__afjfAlive()) return;
  window.__afjfAlive = alive;
  document.getElementById("afjf-panel")?.remove(); // panel left by a disconnected old copy
  // Only the top page runs the filter (an ad opened in our hidden iframe also matches the manifest)
  if (window !== window.top) return;

  let running = false;
  let stopRequested = false;
  // "Auto next page" setting, kept in chrome.storage (the panel can be re-created)
  let autoNextOn = false;
  let lastDonePage = 0; // page number of the last finished run on this page (0 = none)
  chrome.storage.local.get("autoNext").then(({ autoNext }) => {
    autoNextOn = autoNext === true;
    ui.syncAutoNext();
  }).catch(() => {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "AFJF_TOGGLE") {
      if (running && !ui.visible()) {
        ui.show(); // panel was closed: just bring it back, keep running
        ui.status("Running…");
      } else if (running) {
        stopRequested = true;
        ui.status("Stopping after the current ad…");
      } else {
        waitForCards(6000).then((ok) => {
          if (!ok) return diagnose();
          run(currentPageNo()).catch((e) => {
            ui.status("Error: " + e.message);
            finish();
          });
        });
      }
      sendResponse({ ok: true });
    }
  });

  // ================= DOM helpers (Platsbanken, Angular + "digi" web components, 2026-11) =================
  //   card:      <pb-feature-search-result-card> → h3 > a[href="/platsbanken/annonser/<id>"]
  //   company:   .pb-company-name · location: .pb-workplaces · occupation: .pb-job-role · date: .pb-job-date
  //   applied:   <pb-feature-applied-indicator> without the [hidden] attribute ("Ansökt")
  //   save:      <pb-feature-save-job> digi-button[aria-label="spara annons, …"] ↔ "annonsen är sparad, …"
  //   paging:    <digi-navigation-pagination> .digi-navigation-pagination__button--next (…--hidden on the last page)
  const CARD_SEL = "pb-feature-search-result-card";
  const AD_LINK = 'a[href*="/platsbanken/annonser/"]';

  function getCards() {
    return [...document.querySelectorAll(CARD_SEL)].filter((c) => c.querySelector(AD_LINK));
  }
  // Platsbanken ads: /platsbanken/annonser/<digits>
  // "Externa webbplatser" ads: /platsbanken/annonser/joblinks/<hex hash> (short summary + link to the source site)
  function cardJobId(card) {
    const m = (card.querySelector(AD_LINK)?.getAttribute("href") || "").match(/annonser\/(?:joblinks\/)?([0-9a-z]+)/i);
    return m ? m[1] : null;
  }
  const isExternalId = (id) => !!id && !/^\d+$/.test(id);
  function findCard(jobId) {
    return getCards().find((c) => cardJobId(c) === jobId) || null;
  }
  async function waitForCards(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (getCards().length) return true;
      await sleep(300);
    }
    return getCards().length > 0;
  }

  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  function cardInfo(card) {
    const a = card.querySelector("h3 a") || card.querySelector(AD_LINK);
    // the link also holds a hidden " (1 jobb)" span
    const title = clean([...(a?.childNodes || [])].filter((n) => !(n.nodeType === 1 && n.hidden)).map((n) => n.textContent).join(""));
    return {
      title,
      company: clean(card.querySelector(".pb-company-name")?.textContent),
      location: clean(card.querySelector(".pb-workplaces")?.textContent),
      role: clean(card.querySelector(".pb-job-role")?.textContent),
      date: clean(card.querySelector(".pb-job-date")?.textContent)
    };
  }
  const cardFields = (card) => {
    const i = cardInfo(card);
    return [i.title, i.company, i.location, i.role].filter(Boolean);
  };
  const cardText = (card) => {
    const i = cardInfo(card);
    return [i.title, i.company, i.location, i.role, i.date].filter(Boolean).join(" | ");
  };

  function isApplied(card) {
    const el = card.querySelector("pb-feature-applied-indicator");
    return !!el && !el.hasAttribute("hidden");
  }

  function findSaveButton(card) {
    return card.querySelector('pb-feature-save-job digi-button, pb-feature-save-job [aria-label*="spara" i], digi-button[af-id="save-ad-btn"]');
  }
  // "annonsen är sparad, …" (saved) vs "spara annons, …" (not saved); English UI as a fallback
  const isSavedLabel = (l) => /\bsparad\b|\bsaved\b/i.test(l || "") && !/^\s*(spara annons|save ad)/i.test(l || "");
  function isSavedCard(card) {
    return isSavedLabel(findSaveButton(card)?.getAttribute("aria-label"));
  }

  // ================= Reading an ad =================
  // Platsbanken has no preview pane, so every ad is opened separately:
  //   "iframe": a hidden same-origin iframe inside this page (fast, nothing visible)
  //   "tab":    an inactive background tab, opened and closed by background.js
  // If that fails, the JSON endpoint the site itself uses is tried as a last resort.
  function adUrl(jobId) {
    return `${location.origin}/platsbanken/annonser/${isExternalId(jobId) ? "joblinks/" : ""}${jobId}`;
  }

  async function extractViaIframe(jobId) {
    const f = document.createElement("iframe");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    // off-screen but rendered (visibility:hidden or display:none would make innerText empty)
    f.style.cssText = "position:fixed;left:-12000px;top:0;width:1200px;height:900px;border:0;pointer-events:none;";
    f.src = adUrl(jobId);
    const loaded = new Promise((res, rej) => {
      f.onload = res;
      setTimeout(() => rej(new Error("Ad page did not load (timeout)")), 20000);
    });
    document.body.appendChild(f);
    try {
      await loaded;
      if (!f.contentDocument) throw new Error("Ad frame is not readable");
      return await window.__afjfExtract(f.contentDocument);
    } finally {
      f.remove();
    }
  }

  async function extractViaTab(jobId) {
    const resp = await chrome.runtime.sendMessage({ type: "AFJF_EXTRACT_TAB", url: adUrl(jobId) });
    if (!resp?.ok) throw new Error(resp?.error || "No answer from the background tab");
    return resp.job;
  }

  async function extractViaApi(jobId) {
    const r = await fetch(`https://platsbanken-api.arbetsformedlingen.se/jobs/v1/job/${jobId}`, { credentials: "omit" });
    if (!r.ok) throw new Error(`Platsbanken API HTTP ${r.status}`);
    const j = await r.json();
    const { description, ...rest } = j || {};
    return {
      title: j?.title || j?.headline || "",
      company: j?.company?.name || "",
      detailText: (window.__afjfHtmlToText(description) + "\n\nOther ad fields (JSON): " + JSON.stringify(rest)).slice(0, 9000)
    };
  }

  // ---------- External ads ("Externa webbplatser") ----------
  // Platsbanken only shows a ~300 character summary and a link to the source site (ledigajobb.se, …).
  // 1. summary: Platsbanken's JSON endpoint (fast; it also has company and municipality), or the hidden-iframe/tab page
  // 2. full ad: background.js fetches the source page (setting readExternalSource; needs the optional
  //    "all sites" permission), and if that gives too little text, reads it in a background tab.
  async function externalSummaryFromApi(jobId) {
    const r = await fetch(`https://platsbanken-api.arbetsformedlingen.se/jobs/v1/job/joblinks/${jobId}`, { credentials: "omit" });
    if (!r.ok) throw new Error(`Platsbanken API HTTP ${r.status}`);
    const j = await r.json();
    const w = (j.workplaces || [])
      .map((p) => [p.municipality, p.region].filter(Boolean).join(", "))
      .filter(Boolean);
    return {
      title: j.title || "",
      company: j.company?.name || "",
      location: w.join("; "),
      occupation: j.occupation || "",
      published: (j.publishedDate || "").slice(0, 10),
      description: window.__afjfHtmlToText(j.description || ""),
      sourceUrl: j.sourceLinks?.[0]?.url || "",
      sourceLabel: j.sourceLinks?.[0]?.label || ""
    };
  }

  async function extractExternal(card, jobId, mode, settings) {
    const info = cardInfo(card);
    let sum;
    try {
      sum = await externalSummaryFromApi(jobId);
    } catch (e) {
      const page = mode === "tab" ? await extractViaTab(jobId) : await extractViaIframe(jobId);
      sum = { title: page.title, company: "", location: page.location || "", occupation: "", published: "", description: page.description || page.detailText, sourceUrl: page.sourceUrl || "", sourceLabel: "" };
    }
    let full = null;
    let fullNote = "";
    if ((settings?.readExternalSource ?? true) && sum.sourceUrl) {
      const resp = await chrome.runtime.sendMessage({ type: "AFJF_FETCH_SOURCE", url: sum.sourceUrl, allowTab: true }).catch((e) => ({ ok: false, error: e.message }));
      if (resp?.ok && resp.page?.text && resp.page.text.length > sum.description.length + 150) full = resp.page;
      else fullNote = resp?.ok ? "the source page had no more text than the summary" : resp?.error || "no answer";
    } else if (!sum.sourceUrl) fullNote = "no source link";
    else fullNote = 'reading source sites is turned off in the options';

    let host = "";
    try { host = new URL(full?.url || sum.sourceUrl).hostname.replace(/^www\./, ""); } catch {}
    const head = [
      `Title: ${sum.title || info.title}`,
      `Company: ${sum.company || full?.company || "(not given)"}`,
      `Location: ${sum.location || "(not given)"}`,
      sum.occupation && `Occupation: ${sum.occupation}`,
      sum.published && `Published: ${sum.published}`,
      `Source: external site ${host || sum.sourceLabel || "(unknown)"} (ad listed under Platsbanken's "Externa webbplatser")`
    ].filter(Boolean).join("\n");
    const detailText = full
      ? `${head}\n\n=== Full ad from ${host} ===\n${full.text}`
      : `${head}\n\n=== Summary shown on Platsbanken ===\n${sum.description}\n\n` +
        `NOTE: only this short summary was available (${fullNote}). Missing details are not a reason to reject; score by what is there.`;
    return {
      title: sum.title || full?.title || info.title,
      company: sum.company || full?.company || info.company,
      location: sum.location,
      cardText: cardText(card),
      detailText: detailText.slice(0, 9000),
      summaryOnly: !full,
      summaryWhy: fullNote,
      source: host
    };
  }

  async function openAndExtract(card, jobId, mode, settings) {
    if (isExternalId(jobId)) return extractExternal(card, jobId, mode, settings);
    const info = cardInfo(card);
    let job;
    let firstError;
    try {
      job = mode === "tab" ? await extractViaTab(jobId) : await extractViaIframe(jobId);
    } catch (e) {
      firstError = e;
      if (/removed/i.test(e.message)) throw e;
      job = await extractViaApi(jobId).catch((e2) => {
        throw new Error(`${firstError.message}; API fallback: ${e2.message}`);
      });
    }
    return {
      title: job.title || info.title,
      company: job.company || info.company,
      cardText: cardText(card),
      detailText: job.detailText
    };
  }

  // ================= Keyword auto-reject =================
  function parseKeywords(str) {
    return String(str || "")
      .split(/[,\n]/)
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => ({
        k,
        // whole-word match, case-insensitive ("Solna" won't match "Solnavägen")
        re: new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[^\\p{L}\\p{N}]|$)`, "iu")
      }));
  }

  // Auto-reject keywords: NOT trimmed, spaces are significant (" AI " ≠ "AI").
  // Case-insensitive substring match; each field is padded with one space on both sides.
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

  // ================= Location rule =================
  // The ad must be in a commutable place (settings.commuteLocations) or be remote (distans).
  // Card location looks like "Stockholm (På plats)", "Göteborg (Hybrid)", "Stockholm, Göteborg", "Distans".
  const VAGUE_PLACE = /^(sverige|sweden|flera orter|flera kommuner|hela sverige|ospecificerad.*|utomlands|europa|europe|norden)$/i;
  function locationProblem(card, places) {
    return textLocationProblem(cardInfo(card).location, places);
  }
  function textLocationProblem(loc, places) {
    if (!places.length) return null; // rule disabled
    loc = clean(loc);
    if (!loc) return null;
    if (/distans|remote|på distans/i.test(loc)) return null;
    const place = loc.replace(/\(.*?\)/g, "").trim();
    if (!place) return null;
    const parts = place.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    if (parts.every((x) => VAGUE_PLACE.test(x))) return null; // too vague: let the AI decide
    if (places.some(({ re }) => re.test(place))) return null;
    return loc;
  }

  // ================= Save matching ads (Platsbanken's heart button on the card) =================
  let savedIds = new Set();
  chrome.storage.local.get("savedIds").then(({ savedIds: d }) => {
    for (const id of d || []) savedIds.add(id);
  });
  function rememberSaved(jobId) {
    savedIds.add(jobId);
    chrome.storage.local.set({ savedIds: [...savedIds].slice(-5000) }).catch(() => {});
  }
  // Returns "saved" | "already" | "missing" | "failed". It is a toggle, so only click when not saved.
  async function saveJob(jobId) {
    const card = findCard(jobId);
    const btn = card && findSaveButton(card);
    if (!btn) return "missing";
    if (isSavedLabel(btn.getAttribute("aria-label"))) {
      rememberSaved(jobId);
      return "already";
    }
    (btn.shadowRoot?.querySelector("button") || btn.querySelector("button") || btn).click();
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      const b = findSaveButton(findCard(jobId) || card);
      if (isSavedLabel(b?.getAttribute("aria-label"))) {
        rememberSaved(jobId);
        return "saved";
      }
    }
    return "failed";
  }

  // ================= Next page (auto) =================
  const currentPageNo = () => Math.max(1, parseInt(new URL(location.href).searchParams.get("page") || "1", 10) || 1);
  function findNextButton() {
    const nav = document.querySelector("digi-navigation-pagination");
    if (!nav) return { why: "pagination not found (only one page?)" };
    const total = parseInt(nav.getAttribute("af-total-pages") || "0", 10);
    if (total && currentPageNo() >= total) return { why: `last page (${total} of ${total})` };
    const host =
      nav.querySelector(".digi-navigation-pagination__button--next") ||
      [...nav.querySelectorAll("button")].find((b) => /^(nästa|next)$/i.test((b.getAttribute("aria-label") || b.innerText || "").trim()))?.closest("digi-button");
    if (!host) return { why: "Next button not found" };
    if (host.classList.contains("digi-navigation-pagination__button--hidden")) return { why: "Next button is hidden (last page)" };
    const btn = host.querySelector("button") || host.shadowRoot?.querySelector("button") || host;
    if (btn.disabled) return { why: "Next button is disabled (last page)" };
    return { btn };
  }

  const pageSignature = () => currentPageNo() + "|" + getCards().slice(0, 3).map(cardJobId).join(",");

  // Returns { ok: true } or { ok: false, why: "…" }
  async function goToNextPage(nextPageNo) {
    const found = findNextButton();
    if (!found.btn) return { ok: false, why: found.why };
    const sigBefore = pageSignature();
    const pageBefore = currentPageNo();
    try { sessionStorage.setItem("afjf-autorun", String(nextPageNo)); } catch {}
    found.btn.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(400);
      if (pageSignature() !== sigBefore && getCards().length && currentPageNo() !== pageBefore) {
        await sleep(1200); // let the new page settle
        try { sessionStorage.removeItem("afjf-autorun"); } catch {}
        window.scrollTo(0, 0);
        return { ok: true };
      }
    }
    // URL moved on but no results rendered: a full reload usually fixes it; the reloaded script continues
    if (currentPageNo() !== pageBefore && !getCards().length) {
      location.reload();
      await sleep(60000);
      return { ok: false, why: "page reload did not happen" };
    }
    try { sessionStorage.removeItem("afjf-autorun"); } catch {}
    return { ok: false, why: `clicked Next but the page did not change (page=${currentPageNo()})` };
  }

  // ================= Cache (avoid paying twice for the same ad) =================
  // Kept in memory too, so earlier results can be shown on every results page without a run.
  let cacheMem = {};
  let settingsMem = {};
  chrome.storage.local.get(["scoreCache", "settings"]).then(({ scoreCache, settings }) => {
    cacheMem = scoreCache || {};
    settingsMem = settings || {};
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.scoreCache) cacheMem = ch.scoreCache.newValue || {};
    if (ch.settings) settingsMem = ch.settings.newValue || {};
  });
  async function getCache() {
    const { scoreCache } = await chrome.storage.local.get("scoreCache");
    return scoreCache || {};
  }
  let cacheWrite = Promise.resolve();
  function putCache(jobId, result) {
    // serialize writes so parallel results don't overwrite each other
    cacheWrite = cacheWrite.then(async () => {
      const c = await getCache();
      c[jobId] = { ...result, ts: Date.now() };
      await chrome.storage.local.set({ scoreCache: c });
    }).catch(() => {});
    return cacheWrite;
  }
  const isFit = (r, threshold) => r.decision === "match" && r.score >= threshold;

  // ================= Main loop =================
  // pageNo > 1 and continuing = log is kept across pages
  async function run(pageNo = 1, continuing = false) {
    const { settings } = await chrome.storage.local.get("settings");
    const threshold = settings?.threshold ?? 55;
    const delayMs = (settings?.delaySec ?? 0) * 1000;
    const dryRun = !!settings?.dryRun;
    const mode = settings?.openMode === "tab" ? "tab" : "iframe";
    const MAX_PARALLEL = 5; // AI requests in flight at once

    running = true;
    stopRequested = false;
    ui.show();
    ui.setRunning(true);
    if (!continuing) ui.reset();
    const section = onExternalTab() ? "Externa webbplatser" : "Platsbanken";
    ui.log(`—— ${section} · page ${pageNo} ——`, "", "info");
    ui.status(`${section} · page ${pageNo} · ` + (dryRun ? "Running (dry run: nothing is hidden or saved)…" : "Running…"));

    const processed = new Set();
    const stats = (run.stats = continuing && run.stats ? run.stats : { match: 0, saved: 0, rejected: 0, keyword: 0, location: 0, skipped: 0, errors: 0 });
    const doSave = (settings?.saveMatches ?? true) && !dryRun;
    const keywords = parseBlockKeywords(settings?.blockKeywords);
    const places = parseKeywords(settings?.commuteLocations);
    const cache = await getCache();
    const inFlight = new Set();
    let opened = 0;
    let total = 0;

    const refreshStatus = (extra = "") =>
      ui.status(`${section} · page ${pageNo} · checked ${opened}/${total} · scoring ${inFlight.size}${extra ? " · " + extra : ""}`);

    async function applyResult(jobId, title, result, fromCache, note = "") {
      const fit = isFit(result, threshold);
      badge(jobId, { ...result, prefix: fromCache ? "(earlier) " : "" }, fit);
      if (fit) {
        stats.match++;
        ui.log(`✅ ${result.score} · ${title}`, result.reason + note, "ok", adUrl(jobId));
        if (doSave && !savedIds.has(jobId)) {
          const r = await saveJob(jobId);
          if (r === "saved") stats.saved++;
          if (r === "failed" || r === "missing") ui.log(`⚠️ could not press Save · ${title}`, r, "warn", adUrl(jobId));
        }
      } else {
        stats.rejected++;
        ui.log(`❌ ${result.score} · ${title}`, result.reason + note, "bad", adUrl(jobId));
      }
      ui.stats(stats, dryRun);
    }

    function handleError(jobId, title, e) {
      stats.errors++;
      badge(jobId, { label: "⚠ Error (not checked)", kind: "warn", reason: e.message }, false);
      ui.log(`⚠️ error · ${title || "ad " + jobId}`, e.message, "warn", adUrl(jobId));
      if (/HTTP 40[13]/.test(e.message) && !/Platsbanken/.test(e.message)) {
        ui.status("API key rejected. Check the extension options.");
        stopRequested = true;
      }
      ui.stats(stats, dryRun);
    }

    function reject(jobId, title, label, reason, logHead, counter) {
      badge(jobId, { label, reason }, false);
      stats[counter]++;
      ui.log(logHead + " · " + title, reason, "bad", adUrl(jobId));
      ui.stats(stats, dryRun);
    }

    // Opening ads is sequential, but scoring runs in parallel in the background.
    for (let pass = 0; pass < 2 && !stopRequested; pass++) {
      const ids = [...new Set(getCards().map(cardJobId))].filter((id) => id && !processed.has(id));
      if (!ids.length) break;
      total += ids.length;

      for (const jobId of ids) {
        if (stopRequested) break;
        processed.add(jobId);
        opened++;
        chrome.runtime.sendMessage({ type: "AFJF_STATE", running: true, progress: String(opened) }).catch(() => {});

        const card = findCard(jobId);
        if (!card) continue;
        const title = cardInfo(card).title || jobId;

        if (isApplied(card) || isSavedCard(card) || savedIds.has(jobId)) {
          const applied = isApplied(card);
          badge(jobId, {
            label: applied ? "• Ansökt (skipped)" : "🔖 Saved (skipped)",
            kind: "skip",
            reason: applied ? "You already applied to this ad" : "Already saved, not checked again"
          }, null);
          stats.skipped++;
          ui.stats(stats, dryRun);
          continue;
        }

        const hit = keywordHit(card, keywords);
        if (hit) {
          reject(jobId, title, `🚫 Keyword: ${hit.keyword.trim()}`, `Keyword "${hit.keyword}" found in "${hit.field}"`, `🚫 keyword "${hit.keyword.trim()}"`, "keyword");
          continue;
        }

        const badLoc = locationProblem(card, places);
        if (badLoc) {
          reject(jobId, title, `📍 Location: ${badLoc}`, `Not in your commutable places and not remote: ${badLoc}`, "📍 not commutable/remote", "location");
          continue;
        }

        if (cache[jobId]) {
          await applyResult(jobId, title, cache[jobId], true);
          continue;
        }

        while (inFlight.size >= MAX_PARALLEL && !stopRequested) await Promise.race(inFlight);
        if (stopRequested) break;

        let job;
        try {
          refreshStatus("opening ad…");
          ui.markActive(jobId);
          job = await openAndExtract(card, jobId, mode, settings);
        } catch (e) {
          handleError(jobId, title, e);
          continue;
        } finally {
          ui.markActive(null);
        }

        // External cards show no company/location, so the no-AI rules run again on what was read
        if (isExternalId(jobId)) {
          const t = job.title || title;
          const hitX = keywords.length ? [job.company, job.location].filter(Boolean).map((f) => {
            const hay = (" " + f + " ").toLowerCase();
            const k = keywords.find(({ low }) => hay.includes(low));
            return k && { keyword: k.k, field: f };
          }).find(Boolean) : null;
          if (hitX) {
            reject(jobId, t, `🚫 Keyword: ${hitX.keyword.trim()}`, `Keyword "${hitX.keyword}" found in "${hitX.field}"`, `🚫 keyword "${hitX.keyword.trim()}"`, "keyword");
            continue;
          }
          const badLocX = textLocationProblem(job.location, places);
          if (badLocX) {
            reject(jobId, t, `📍 Location: ${badLocX}`, `Not in your commutable places and not remote: ${badLocX}`, "📍 not commutable/remote", "location");
            continue;
          }
        }
        const note = isExternalId(jobId) ? (job.summaryOnly ? ` · ⓘ external, summary only (${job.summaryWhy})` : ` · ⓘ full ad read from ${job.source}`) : "";

        const p = chrome.runtime
          .sendMessage({ type: "AFJF_SCORE", job })
          .then(async (resp) => {
            if (!resp?.ok) throw new Error(resp?.error || "No response from background");
            await putCache(jobId, resp.result);
            await applyResult(jobId, job.title || title, resp.result, false, note);
          })
          .catch((e) => handleError(jobId, title, e))
          .finally(() => {
            inFlight.delete(p);
            refreshStatus();
          });
        inFlight.add(p);
        refreshStatus();
        if (delayMs) await sleep(delayMs);
      }
    }

    refreshStatus("waiting for last scores…");
    await Promise.all(inFlight);

    ui.status(stopRequested ? "Stopped." : `Page ${pageNo} done (${opened} ads).` + (ui.autoNext() ? "" : ' Tick "Auto next page" to continue with the next page.'));
    ui.stats(stats, dryRun);
    lastDonePage = stopRequested ? 0 : pageNo;

    if (!stopRequested && ui.autoNext()) {
      ui.status(`Page ${pageNo} done · going to the next page…`);
      const res = await goToNextPage(pageNo + 1);
      lastDonePage = 0;
      if (res.ok && !stopRequested && ui.autoNext()) {
        finish();
        return run(currentPageNo(), true);
      }
      if (!res.ok) ui.log(`⏹ No next page after page ${pageNo}`, res.why, "warn");
      // End of the Platsbanken tab: continue with the "Externa webbplatser" tab (setting includeExternal)
      if (!res.ok && !stopRequested && (settings?.includeExternal ?? true) && !onExternalTab()) {
        ui.status("Platsbanken done · switching to Externa webbplatser…");
        const sw = await switchToExternalTab();
        if (sw.ok && !stopRequested && ui.autoNext()) {
          finish();
          return run(currentPageNo(), true);
        }
        if (!sw.ok) ui.log("⏹ Externa webbplatser not checked", sw.why, "warn");
      }
      ui.status(stopRequested ? "Stopped." : res.ok ? "Stopped." : `Done · no next page after page ${pageNo} (${res.why}).`);
    }
    finish();
  }

  // ================= Result tabs: "Platsbanken (66)" / "Externa webbplatser (11)" =================
  // button[role=tab] in div[role=tablist]; the Externa tab adds &s=2 to the URL.
  const resultTabs = () => [...document.querySelectorAll('[role="tablist"] [role="tab"], button[role="tab"]')];
  const tabLabel = (t) => (t.getAttribute("aria-label") || t.innerText || "").replace(/\s+/g, " ").trim();
  function onExternalTab() {
    const sel = resultTabs().find((t) => t.getAttribute("aria-selected") === "true");
    if (sel) return /^externa|external/i.test(tabLabel(sel));
    return new URL(location.href).searchParams.get("s") === "2";
  }
  async function switchToExternalTab() {
    const t = resultTabs().find((b) => /^externa|external/i.test(tabLabel(b)));
    if (!t) return { ok: false, why: "Externa webbplatser tab not found" };
    const n = (tabLabel(t).match(/\((\d+)/) || [])[1];
    if (n === "0") return { ok: false, why: "Externa webbplatser has no ads for this search" };
    t.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(400);
      if (onExternalTab() && getCards().some((c) => isExternalId(cardJobId(c)))) {
        await sleep(1200);
        window.scrollTo(0, 0);
        return { ok: true };
      }
    }
    return { ok: false, why: "clicked the Externa webbplatser tab but no external ads appeared" };
  }

  function diagnose() {
    const info = {
      url: location.href,
      cardElements: document.querySelectorAll(CARD_SEL).length,
      adLinks: document.querySelectorAll(AD_LINK).length,
      saveButtons: document.querySelectorAll("pb-feature-save-job").length,
      pagination: !!document.querySelector("digi-navigation-pagination"),
      customTags: [...new Set([...document.querySelectorAll("*")].map((e) => e.tagName.toLowerCase()).filter((t) => /^pb-/.test(t)))].slice(0, 30)
    };
    console.log("[AFJF] diagnostic", info);
    ui.show();
    ui.reset();
    ui.status("No ads found on this page. Diagnostic (please send this to Claude):");
    ui.log("Diagnostic", JSON.stringify(info), "warn");
  }

  // "Auto next page" ticked after the run finished a page: go to the next page and run there
  async function continueWithNextPage() {
    const pageNo = lastDonePage;
    lastDonePage = 0;
    running = true;
    ui.setRunning(true);
    ui.status(`Page ${pageNo} done · going to the next page…`);
    const res = await goToNextPage(pageNo + 1);
    running = false;
    if (res.ok && !stopRequested && autoNextOn) return run(currentPageNo(), true).catch((e) => { ui.status("Error: " + e.message); finish(); });
    if (!res.ok) ui.log(`⏹ No next page after page ${pageNo}`, res.why, "warn");
    ui.status(res.ok ? "Stopped." : `Done · no next page after page ${pageNo} (${res.why}).`);
    finish();
  }

  function finish() {
    running = false;
    stopRequested = false;
    ui.setRunning(false);
    chrome.runtime.sendMessage({ type: "AFJF_STATE", running: false }).catch(() => {});
  }

  // ================= Badges and dimming =================
  // Angular re-renders cards (paging, back navigation), so results are remembered per ad id and
  // re-applied every second. Badges from earlier runs are shown too (settings.showPrevious).
  const badges = new Map(); // jobId -> { label, kind, reason, fit }
  const BADGE_COLORS = { ok: "#1e8e3e", bad: "#c5221f", skip: "#6b7280", warn: "#b06000" };

  // result: { score, reason, label?, kind?, prefix? }; fit: true / false / null (null = neither, e.g. skipped)
  function badge(jobId, result, fit) {
    if (!jobId) return;
    let label = result.label;
    if (!label) {
      const tag = (String(result.reason || "").match(/^\s*\[(\w+)\]/) || [])[1];
      label = `${result.prefix || ""}${fit ? "✓" : "✕"} AI ${result.score}${tag ? " · " + tag : ""}`;
    }
    badges.set(jobId, { label, kind: result.kind || (fit ? "ok" : "bad"), reason: result.reason || "", fit });
    applyBadge(jobId);
  }

  function applyBadge(jobId, card = findCard(jobId)) {
    const info = badges.get(jobId);
    if (!info || !card) return;
    const box = card.querySelector(".card-container") || card;
    let b = box.querySelector(":scope > .afjf-badge");
    if (!b || b.textContent !== info.label || b.title !== info.reason) {
      b?.remove();
      b = document.createElement("div");
      b.className = "afjf-badge";
      b.textContent = info.label;
      b.title = info.reason; // full reason on hover
      Object.assign(b.style, {
        display: "inline-block",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        margin: "0 0 6px",
        padding: "2px 8px",
        borderRadius: "10px",
        font: "600 12px system-ui, sans-serif",
        color: "#fff",
        background: BADGE_COLORS[info.kind] || BADGE_COLORS.bad,
        cursor: "help"
      });
      box.prepend(b);
    }
    // rejected ads: dim or hide (never in dry run)
    const mode = settingsMem.dryRun ? "none" : settingsMem.markRejected || "dim";
    const rejected = info.fit === false;
    const wantOpacity = rejected && mode === "dim" ? "0.45" : "";
    const wantDisplay = rejected && mode === "hide" ? "none" : "";
    if (box.style.opacity !== wantOpacity) box.style.opacity = wantOpacity;
    if (card.style.display !== wantDisplay) card.style.display = wantDisplay;
  }

  setInterval(() => {
    if (!alive()) return;
    const threshold = settingsMem.threshold ?? 55;
    const showPrev = settingsMem.showPrevious ?? true;
    for (const card of getCards()) {
      const id = cardJobId(card);
      if (!id) continue;
      if (!badges.has(id) && showPrev && cacheMem[id]) {
        const r = cacheMem[id];
        badge(id, { ...r, prefix: "(earlier) " }, isFit(r, threshold));
      }
      applyBadge(id, card);
    }
  }, 1000);

  // If a Next click caused a full page load, pick up where we left off
  try {
    const autorun = sessionStorage.getItem("afjf-autorun");
    if (autorun) {
      sessionStorage.removeItem("afjf-autorun");
      let tries = 0;
      const tick = () => {
        if (running) return;
        if (!autoNextOn) return tries++ < 5 && setTimeout(tick, 1000); // setting is read asynchronously
        if (getCards().length) run(currentPageNo(), false).catch((e) => { ui.status("Error: " + e.message); finish(); });
        else if (++tries < 20) setTimeout(tick, 1000);
      };
      setTimeout(tick, 2000);
    }
  } catch {}

  // ================= Floating panel =================
  const ui = (() => {
    let root, statusEl, statsEl, logEl, autoNextEl;
    function build() {
      root = document.createElement("div");
      root.id = "afjf-panel";
      root.innerHTML = `
        <div data-r="handle" title="Drag to move" style="display:flex;align-items:center;gap:8px;margin:-10px -12px 6px;padding:8px 12px;cursor:move;user-select:none;background:#e8f3ef;border-radius:10px 10px 0 0;border-bottom:1px solid #d5e5df">
          <strong style="flex:1">⠿ Platsbanken AI Filter</strong>
          <button data-a="details" style="cursor:pointer" title="Show/hide per-ad report">Details ▾</button>
          <button data-a="rerun" style="cursor:pointer;display:none" title="Run again on the ads now on this page">↻ Run again</button>
          <button data-a="stop" style="cursor:pointer">Stop</button>
          <button data-a="close" style="cursor:pointer">✕</button>
        </div>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:4px;cursor:pointer;user-select:none"><input type="checkbox" data-a="autonext"> Auto next page <span style="color:#777">(until Stop)</span></label>
        <div data-r="status" style="margin-bottom:4px"></div>
        <div data-r="stats" style="margin-bottom:6px;color:#555"></div>
        <div data-r="log" style="display:none;max-height:420px;overflow:auto;border-top:1px solid #ddd;padding-top:4px"></div>`;
      Object.assign(root.style, {
        position: "fixed",
        left: "16px",
        bottom: "16px",
        width: "340px",
        zIndex: 2147483647,
        background: "#fff",
        color: "#222",
        border: "1px solid #ccc",
        borderRadius: "10px",
        boxShadow: "0 6px 24px rgba(0,0,0,.18)",
        padding: "10px 12px",
        font: "13px/1.4 system-ui, sans-serif",
        textAlign: "left"
      });
      statusEl = root.querySelector('[data-r="status"]');
      autoNextEl = root.querySelector('[data-a="autonext"]');
      autoNextEl.checked = autoNextOn;
      autoNextEl.onchange = () => {
        autoNextOn = autoNextEl.checked;
        chrome.storage.local.set({ autoNext: autoNextOn }).catch(() => {});
        if (autoNextOn && !running && lastDonePage > 0) continueWithNextPage();
      };
      statsEl = root.querySelector('[data-r="stats"]');
      logEl = root.querySelector('[data-r="log"]');
      const detailsBtn = root.querySelector('[data-a="details"]');
      const setExpanded = (on) => {
        logEl.style.display = on ? "block" : "none";
        root.style.width = on ? "480px" : "340px";
        detailsBtn.textContent = on ? "Details ▴" : "Details ▾";
        try { localStorage.setItem("afjf-panel-expanded", on ? "1" : "0"); } catch {}
        const r = root.getBoundingClientRect();
        if (r.right > window.innerWidth) root.style.left = Math.max(0, window.innerWidth - r.width - 8) + "px";
        if (r.bottom > window.innerHeight && root.style.top) root.style.top = Math.max(0, window.innerHeight - r.height - 8) + "px";
      };
      let expanded = false;
      try { expanded = localStorage.getItem("afjf-panel-expanded") === "1"; } catch {}
      detailsBtn.onclick = () => setExpanded((expanded = !expanded));
      root.querySelector('[data-a="rerun"]').onclick = () => {
        if (running) return;
        if (!getCards().length) return status("No ads found on this page.");
        run(currentPageNo()).catch((e) => {
          status("Error: " + e.message);
          finish();
        });
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
      const KEY = "afjf-panel-pos";
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
    function visible() {
      return !!root && document.body.contains(root);
    }
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
        statsEl.textContent = `Match: ${s.match} (🔖 saved now: ${s.saved || 0}) · ${dry ? "Would reject" : "Rejected"} by AI: ${s.rejected} · by keyword: ${s.keyword} · by location: ${s.location} · Skipped (applied/saved): ${s.skipped} · Errors: ${s.errors}`;
    }
    // Outline the card of the ad that is being read right now
    let activeId = null;
    function markActive(jobId) {
      if (activeId) {
        const c = findCard(activeId);
        if (c) c.style.outline = "";
      }
      activeId = jobId;
      const c = jobId && findCard(jobId);
      if (c) {
        c.style.outline = "2px dashed #005c45";
        c.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
    const history = [];
    function log(head, detail, kind, url) {
      history.push([head, detail, kind, url]);
      if (history.length > 400) history.shift();
      render(head, detail, kind, url);
    }
    function render(head, detail, kind, url) {
      if (!logEl) return;
      const d = document.createElement("div");
      d.style.margin = "4px 0";
      d.style.color = { ok: "#1e8e3e", bad: "#c5221f", info: "#005c45" }[kind] || "#b06000";
      const h = document.createElement(url ? "a" : "div");
      h.style.fontWeight = "600";
      h.style.color = "inherit";
      h.textContent = head;
      if (url) {
        h.href = url;
        h.target = "_blank";
        h.rel = "noopener";
        h.title = "Open the ad in a new tab";
      }
      const t = document.createElement("div");
      t.style.cssText = "color:#555;font-size:12px";
      t.textContent = detail || "";
      d.append(h, t);
      logEl.prepend(d);
    }
    function autoNext() {
      return autoNextOn;
    }
    function syncAutoNext() {
      if (autoNextEl) autoNextEl.checked = autoNextOn;
    }
    return { show, visible, setRunning, reset, status, stats, log, autoNext, syncAutoNext, markActive };
  })();
})();
