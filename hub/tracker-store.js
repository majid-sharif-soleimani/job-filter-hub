// Job tracker: one shared list of job records (all sites), kept in chrome.storage.local under
// "hub::applications" (outside the sub-extensions' namespaces). Used by the service worker (records
// matched jobs), the Gmail menu (hub/mail.js) and the hub page.
(() => {
  if (globalThis.JFTracker) return;
  const KEY = "hub::applications";
  const STATUSES = ["Matched", "Applied", "Interview", "Offer", "Rejected", "Withdrawn"];
  const area = () => chrome.storage.local;

  // serialise read-modify-write (several scores can finish at the same time)
  let queue = Promise.resolve();
  const locked = (fn) => (queue = queue.then(fn, fn));

  async function all() {
    const d = await area().get(KEY);
    return Array.isArray(d[KEY]) ? d[KEY] : [];
  }
  const save = (list) => area().set({ [KEY]: list.slice(-5000) });

  const fold = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const recordId = (site, title, company) => `${site}:${fold(company)}|${fold(title)}`.slice(0, 300);

  function upsert(rec) {
    return locked(async () => {
      const list = await all();
      const now = Date.now();
      const id = rec.id || recordId(rec.site || "manual", rec.title, rec.company);
      const i = list.findIndex((r) => r.id === id);
      if (i >= 0) {
        // keep the user's status and notes; refresh what the filter knows
        const keep = list[i];
        list[i] = { ...keep, ...rec, id, status: keep.status, notes: keep.notes, history: keep.history, createdAt: keep.createdAt, updatedAt: now };
      } else {
        list.push({ status: "Matched", notes: "", history: [], ...rec, id, createdAt: now, updatedAt: now });
      }
      await save(list);
      return list.find((r) => r.id === id);
    });
  }

  function update(id, patch) {
    return locked(async () => {
      const list = await all();
      const r = list.find((x) => x.id === id);
      if (!r) return null;
      if (patch.status && patch.status !== r.status) r.history = [...(r.history || []), { status: patch.status, at: Date.now(), from: r.status }];
      Object.assign(r, patch, { updatedAt: Date.now() });
      await save(list);
      return r;
    });
  }

  function remove(id) {
    return locked(async () => save((await all()).filter((r) => r.id !== id)));
  }

  // Called by the service worker when a sub-extension's AI score says "match"
  function recordMatch(sub, job, result, sender) {
    if (!job || !job.title) return;
    return upsert({
      site: sub.id,
      siteName: sub.name,
      title: String(job.title).slice(0, 200),
      company: String(job.company || "").slice(0, 200),
      info: String(job.cardText || "").replace(/\s*\|\s*… checking\s*$/, "").slice(0, 400),
      url: (sender && (sender.url || (sender.tab && sender.tab.url))) || "",
      score: result.score,
      reason: result.reason || ""
    }).catch(() => {});
  }

  // ---------- matching an email to records ----------
  const COMPANY_NOISE = new Set(["ab", "publ", "inc", "ltd", "llc", "gmbh", "as", "asa", "oy", "aps", "bv", "sa", "plc", "corp", "co", "group", "sverige", "sweden", "nordic", "the", "and", "of", "i", "hb", "kb"]);
  const TITLE_NOISE = new Set(["senior", "junior", "lead", "with", "for", "och", "med", "till", "the", "and", "som", "inom", "till", "role", "tjanst"]);
  const words = (s, noise) => fold(s).split(" ").filter((w) => w.length >= 2 && !noise.has(w));

  // email = { subject, fromName, fromEmail, body }
  function scoreRecord(r, email) {
    const subj = " " + fold(email.subject) + " ";
    const from = " " + fold(email.fromName) + " " + fold(email.fromEmail) + " ";
    const body = " " + fold(email.body).slice(0, 20000) + " ";
    const domain = fold(String(email.fromEmail || "").split("@")[1] || "").replace(/ /g, "");
    let score = 0;
    const why = [];

    const cw = words(r.company, COMPANY_NOISE);
    if (cw.length) {
      const core = cw.join(" ");
      const compact = cw.join("");
      if (compact.length >= 3 && domain.includes(compact)) (score += 45), why.push("sender domain");
      else if (from.includes(" " + core + " ")) (score += 45), why.push("sender");
      if (subj.includes(" " + core + " ")) (score += 30), why.push("company in subject");
      else if (body.includes(" " + core + " ")) (score += 20), why.push("company in text");
    }

    const tw = [...new Set(words(r.title, TITLE_NOISE).filter((w) => w.length >= 3))];
    if (tw.length) {
      const phrase = " " + fold(r.title) + " ";
      if (phrase.trim().length >= 6 && (subj.includes(phrase) || body.includes(phrase))) (score += 35), why.push("job title");
      else {
        const hit = tw.filter((w) => subj.includes(" " + w + " ") || body.includes(" " + w + " ")).length / tw.length;
        if (hit >= 0.5) (score += Math.round(30 * hit)), why.push("title words");
      }
    }
    return { score, why };
  }

  function findForEmail(list, email, max = 5) {
    return list
      .map((r) => ({ r, ...scoreRecord(r, email) }))
      .filter((x) => x.score >= 40)
      .sort((a, b) => b.score - a.score || (b.r.updatedAt || 0) - (a.r.updatedAt || 0))
      .slice(0, max);
  }

  function search(list, q) {
    const f = fold(q);
    if (!f) return [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const terms = f.split(" ");
    return list
      .filter((r) => {
        const hay = fold([r.title, r.company, r.siteName, r.status, r.notes].join(" "));
        return terms.every((t) => hay.includes(t));
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  globalThis.JFTracker = { KEY, STATUSES, all, upsert, update, remove, recordMatch, findForEmail, search, recordId };
})();
