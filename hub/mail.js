// Job tracker menu on Gmail. A small "Jobs" button sits at the bottom right; it opens a panel that reads
// the email that is open (subject, sender, text), finds the matching job records (hub/tracker-store.js)
// and lets you change their status and notes. Nothing is sent anywhere: it only reads the page and
// chrome.storage. The toolbar button toggles the panel too.
(() => {
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  if (window !== window.top) return;
  if (window.__jfMailAlive && window.__jfMailAlive()) return;
  window.__jfMailAlive = alive;
  document.getElementById("jf-mail-host")?.remove();

  const T = globalThis.JFTracker;
  const STATUS_COLORS = { Matched: "#6b7280", Applied: "#0a66c2", Interview: "#b06000", Offer: "#1e8e3e", Rejected: "#c5221f", Withdrawn: "#6b7280" };
  const txt = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  const visible = (el) => !!el && el.offsetParent !== null;

  // ---------- read the open email (Gmail DOM as of 2026) ----------
  //   subject: h2.hP   ·   sender: span.gD[email] (name + address)   ·   text: div.a3s (one per message in the thread)
  function readEmail() {
    const subjectEl = [...document.querySelectorAll("h2.hP")].find(visible);
    if (!subjectEl) return null;
    const senders = [...document.querySelectorAll("span.gD[email], .gD[email]")].filter(visible);
    const bodies = [...document.querySelectorAll("div.a3s")].filter(visible);
    const last = senders[senders.length - 1];
    return {
      subject: txt(subjectEl),
      fromName: last ? last.getAttribute("name") || txt(last) : "",
      fromEmail: last ? last.getAttribute("email") || "" : "",
      // all senders of the thread help too (e.g. a recruiter's reply in a thread you started)
      allFrom: senders.map((s) => (s.getAttribute("name") || "") + " " + (s.getAttribute("email") || "")).join(" "),
      body: bodies.map(txt).join("\n").slice(0, 20000)
    };
  }

  // ---------- UI (shadow DOM so Gmail's CSS does not leak in) ----------
  const host = document.createElement("div");
  host.id = "jf-mail-host";
  Object.assign(host.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: 2147483000 });
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font: 13px/1.4 system-ui, sans-serif; color: #222; }
      .fab { all: unset; cursor: pointer; background: #0a66c2; color: #fff; border-radius: 20px; padding: 8px 14px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
      .fab * { color: #fff; }
      .panel { display: none; position: absolute; right: 0; bottom: 44px; width: 380px; max-height: 70vh; overflow: auto; background: #fff; border: 1px solid #ccc; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.25); padding: 10px 12px; }
      .panel.open { display: block; }
      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
      .head strong { flex: 1; font-size: 14px; }
      .muted { color: #666; font-size: 12px; }
      .email { background: #f4f6f8; border-radius: 6px; padding: 6px 8px; margin: 6px 0; }
      .rec { border: 1px solid #e2e2e2; border-radius: 8px; padding: 8px; margin: 8px 0; }
      .rec .t { font-weight: 600; }
      .row { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
      select, input, textarea { border: 1px solid #bbb; border-radius: 6px; padding: 4px 6px; }
      textarea { width: 100%; min-height: 44px; margin-top: 6px; }
      input.q { width: 100%; }
      button { cursor: pointer; border: 1px solid #0a66c2; background: #0a66c2; color: #fff; border-radius: 6px; padding: 4px 10px; }
      button.sec { background: #fff; color: #0a66c2; }
      button.x { border: none; background: none; color: #666; font-size: 16px; padding: 0 4px; }
      .pill { color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
      a { color: #0a66c2; }
      h4 { margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; color: #666; letter-spacing: .03em; }
    </style>
    <button class="fab" data-a="toggle" title="Job tracker: find the job of the open email">💼 Jobs</button>
    <div class="panel">
      <div class="head"><strong>Job tracker</strong><button class="sec" data-a="all" title="Open the list of all records">All records</button><button class="x" data-a="toggle" title="Close">✕</button></div>
      <div data-r="email"></div>
      <h4 data-r="mhead">Matching records</h4>
      <div data-r="matches"></div>
      <h4>Search all records</h4>
      <input class="q" data-r="q" placeholder="Company, job title, status…">
      <div data-r="results"></div>
    </div>`;
  document.documentElement.appendChild(host);
  const $ = (sel) => root.querySelector(sel);
  const panel = $(".panel");

  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "toggle") toggle();
    if (a === "all") chrome.runtime.sendMessage({ type: "HUB_OPEN_TRACKER" }).catch(() => {});
  });
  $('[data-r="q"]').addEventListener("input", () => renderSearch());

  function toggle(force) {
    const open = force ?? !panel.classList.contains("open");
    panel.classList.toggle("open", open);
    if (open) refresh();
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && msg.type === "HUB_TRACKER_TOGGLE") {
      toggle();
      sendResponse({ ok: true });
    }
  });

  // ---------- rendering ----------
  function recordCard(r, why) {
    const box = document.createElement("div");
    box.className = "rec";
    const title = document.createElement("div");
    title.className = "t";
    title.textContent = r.title;
    const sub = document.createElement("div");
    sub.className = "muted";
    sub.textContent = [r.company, r.siteName || r.site, r.score != null ? `AI ${r.score}` : "", why ? "found by: " + why : ""].filter(Boolean).join(" · ");

    const row = document.createElement("div");
    row.className = "row";
    const pill = document.createElement("span");
    pill.className = "pill";
    const sel = document.createElement("select");
    for (const s of T.STATUSES) {
      const o = document.createElement("option");
      o.value = o.textContent = s;
      sel.append(o);
    }
    sel.value = r.status || "Matched";
    const paint = () => {
      pill.textContent = sel.value;
      pill.style.background = STATUS_COLORS[sel.value] || "#6b7280";
    };
    paint();
    const notes = document.createElement("textarea");
    notes.placeholder = "Notes (e.g. interview on Monday 10:00)";
    notes.value = r.notes || "";
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    const msg = document.createElement("span");
    msg.className = "muted";
    saveBtn.onclick = async () => {
      await T.update(r.id, { status: sel.value, notes: notes.value });
      r.status = sel.value;
      r.notes = notes.value;
      paint();
      msg.textContent = "Saved ✔";
      setTimeout(() => (msg.textContent = ""), 2500);
    };
    sel.onchange = () => saveBtn.click();
    row.append(pill, sel, saveBtn, msg);
    if (r.url) {
      const link = document.createElement("a");
      link.href = r.url;
      link.target = "_blank";
      link.textContent = "job page";
      row.append(link);
    }
    box.append(title, sub, row, notes);
    return box;
  }

  let records = [];
  let email = null;

  async function refresh() {
    records = await T.all();
    email = readEmail();
    const e = $('[data-r="email"]');
    const m = $('[data-r="matches"]');
    e.textContent = "";
    m.textContent = "";
    if (!email) {
      e.innerHTML = '<div class="muted">Open an email to find its job. You can also search below.</div>';
      $('[data-r="mhead"]').style.display = "none";
    } else {
      $('[data-r="mhead"]').style.display = "";
      const info = document.createElement("div");
      info.className = "email";
      info.textContent = `✉ ${email.subject} — ${email.fromName || email.fromEmail}`;
      e.append(info);
      const found = T.findForEmail(records, { ...email, fromName: email.fromName + " " + email.allFrom });
      if (!found.length) {
        const none = document.createElement("div");
        none.className = "muted";
        none.textContent = "No record matches this email. Search below, or add it as a new record:";
        m.append(none, addForm());
      } else {
        for (const f of found) m.append(recordCard(f.r, f.why.join(", ")));
      }
    }
    renderSearch();
  }

  // New record from the open email (prefilled: company from the sender, title from the subject)
  function addForm() {
    const box = document.createElement("div");
    box.className = "rec";
    const company = document.createElement("input");
    const title = document.createElement("input");
    company.placeholder = "Company";
    title.placeholder = "Job title";
    company.style.width = title.style.width = "100%";
    title.style.marginTop = "6px";
    const domain = (email.fromEmail.split("@")[1] || "").split(".").slice(-2, -1)[0] || "";
    const generic = /^(gmail|outlook|hotmail|yahoo|live|icloud|teamtailor|workday|myworkday|greenhouse|lever|smartrecruiters|varbi|reachmee|jobylon|linkedin|indeed|noreply|no-reply)$/i;
    company.value = email.fromName && !/no.?reply|team|career|jobs|recruit/i.test(email.fromName) ? email.fromName : generic.test(domain) ? "" : domain;
    title.value = email.subject.replace(/^(re|sv|fwd?|vb):\s*/i, "").slice(0, 150);
    const row = document.createElement("div");
    row.className = "row";
    const sel = document.createElement("select");
    for (const s of T.STATUSES) {
      const o = document.createElement("option");
      o.value = o.textContent = s;
      sel.append(o);
    }
    sel.value = "Applied";
    const add = document.createElement("button");
    add.textContent = "Add record";
    add.onclick = async () => {
      if (!title.value.trim()) return;
      const rec = await T.upsert({ site: "manual", siteName: "Added from email", title: title.value.trim(), company: company.value.trim(), url: location.href });
      await T.update(rec.id, { status: sel.value });
      refresh();
    };
    row.append(sel, add);
    box.append(company, title, row);
    return box;
  }

  function renderSearch() {
    const out = $('[data-r="results"]');
    out.textContent = "";
    const q = $('[data-r="q"]').value;
    if (!q.trim()) {
      const n = document.createElement("div");
      n.className = "muted";
      n.textContent = `${records.length} record(s). Type to search.`;
      out.append(n);
      return;
    }
    const list = T.search(records, q).slice(0, 15);
    if (!list.length) {
      const n = document.createElement("div");
      n.className = "muted";
      n.textContent = "Nothing found.";
      out.append(n);
    }
    for (const r of list) out.append(recordCard(r));
  }

  // Gmail is a single-page app: when another email is opened, refresh the open panel
  let lastKey = "";
  setInterval(() => {
    if (!alive()) return;
    if (!panel.classList.contains("open")) return;
    const key = location.hash + "|" + txt([...document.querySelectorAll("h2.hP")].find(visible));
    if (key !== lastKey) {
      lastKey = key;
      refresh();
    }
  }, 1200);
})();
