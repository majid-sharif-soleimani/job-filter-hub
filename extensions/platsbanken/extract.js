// Reads one Platsbanken ad page (/platsbanken/annonser/<id>) and returns the text to score.
// Used in two places:
//   - content.js, on the contentDocument of a hidden same-origin iframe ("iframe" open mode)
//   - background.js, injected into an inactive tab ("tab" open mode)
// Platsbanken is an Angular app: the page shell loads first, then the ad is fetched from
// platsbanken-api.arbetsformedlingen.se/jobs/v1/job/<id> and rendered, so we poll.
(() => {
  if (window.__afjfExtract) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // HTML -> plain text that keeps paragraph and list breaks (works on hidden/collapsed text too)
  function htmlToText(html) {
    const s = String(html || "")
      .replace(/<li[^>]*>/gi, "\n• ")
      .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "");
    const t = new DOMParser().parseFromString(s, "text/html").documentElement.textContent || "";
    return t.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // Text between two markers of the page text (markers are Swedish UI labels; English UI is a fallback)
  function between(all, fromRe, toRe, maxLen) {
    const m = all.match(fromRe);
    if (!m) return "";
    const rest = all.slice(m.index);
    const e = rest.slice(1).search(toRe);
    return rest.slice(0, e > 0 ? e + 1 : maxLen).slice(0, maxLen).trim();
  }

  window.__afjfHtmlToText = htmlToText;

  window.__afjfExtract = async function (doc, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let desc = null;
    let h1 = null;
    while (Date.now() < deadline) {
      // External ad page (/platsbanken/annonser/joblinks/<hash>): short summary + link to the source site
      const ext = doc.querySelector("pb-page-external-job");
      const extDesc = ext?.querySelector(".description");
      if (ext && extDesc && extDesc.textContent.trim().length > 20) {
        const title = (ext.querySelector("h1.d-block") || [...ext.querySelectorAll("h1")].find((h) => h.offsetParent) || ext.querySelector("h1"))?.textContent.trim() || "";
        const link = ext.querySelector("ul.link-external a[href^='http'], .link-external a[href^='http']");
        const kommun = ((ext.innerText || "").match(/Kommun:\s*([^\n]+)/) || [])[1] || "";
        const description = htmlToText(extDesc.innerHTML);
        return {
          title,
          company: "",
          location: kommun.trim(),
          description,
          sourceUrl: link?.href || "",
          detailText: `${title}\nKommun: ${kommun}\n\n${description}`
        };
      }
      desc = doc.querySelector(".job-description");
      h1 = doc.querySelector("main h1, h1");
      if (desc && h1 && desc.textContent.trim().length > 40) break;
      if (/annonsen (är borttagen|finns inte)|ad (has been removed|not found)|sidan kunde inte hittas/i.test(doc.body?.innerText || ""))
        throw new Error("The ad has been removed");
      await sleep(250);
    }
    if (!desc || !h1) throw new Error("Ad text did not load");
    // wait until the description stops growing
    let last = -1;
    for (let i = 0; i < 8; i++) {
      const len = desc.textContent.length;
      if (len === last) break;
      last = len;
      await sleep(250);
    }

    const title = h1.innerText.trim() || h1.textContent.trim();
    // the employer is the first visible <h2> after the <h1>
    const company =
      [...doc.querySelectorAll("h2")]
        .find((h) => !h.classList.contains("sr-only") && h1.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING)
        ?.innerText.trim() || "";

    const main = doc.querySelector("main") || doc.body;
    const all = (main.innerText || "").replace(/\r/g, "");
    // header: title, employer, occupation, municipality, extent, duration, employment type, deadline
    const i = all.indexOf(title);
    const header = between(i >= 0 ? all.slice(i) : all, /\S/, /\n(Om jobbet|About the job)\n/i, 1500);
    // salary, workplace address, employer site
    const other = between(all, /\n(Övrig information|Other information)\n/i, /\n(Dela annonsen|Share the ad)\n/i, 1200);
    const description = htmlToText(desc.innerHTML);

    return {
      title,
      company,
      detailText: (header + "\n\n=== Om jobbet ===\n" + description + (other ? "\n\n" + other : "")).slice(0, 9000)
    };
  };
})();
