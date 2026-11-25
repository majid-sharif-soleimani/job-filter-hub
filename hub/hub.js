// Hub page: lists the bundled sub-extensions and copies shared settings between them.
const areas = Object.fromEntries(JF_SUBS.map((s) => [s.id, __jfMakeStorageArea(chrome.storage.local, s.id)]));
const SHARED = ["provider", "models", "apiKeys", "resume"];

function isConfigured(settings) {
  if (!settings) return false;
  const p = settings.provider || "anthropic";
  return !!(settings.apiKeys && settings.apiKeys[p] && String(settings.resume || "").trim());
}

async function render() {
  const box = document.getElementById("tools");
  const from = document.getElementById("copyFrom");
  box.textContent = "";
  from.textContent = "";
  for (const s of JF_SUBS) {
    const { settings } = await areas[s.id].get("settings");
    const ok = isConfigured(settings);
    const row = document.createElement("div");
    row.className = "tool";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = s.name;
    const st = document.createElement("span");
    st.className = "status" + (ok ? " ok" : "");
    st.textContent = ok ? "ready" : "needs API key and resume";
    const settingsBtn = document.createElement("button");
    settingsBtn.textContent = "Settings";
    settingsBtn.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL(`generated/${s.id}/options.html`) });
    const site = document.createElement("a");
    site.className = "btn secondary";
    site.href = s.site;
    site.target = "_blank";
    site.textContent = "Open site";
    row.append(name, st, settingsBtn, site);
    box.append(row);

    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name + (ok ? "" : " (not set up)");
    if (ok && !from.dataset.picked) {
      opt.selected = true;
      from.dataset.picked = "1";
    }
    from.append(opt);
  }
  delete from.dataset.picked;
}

document.getElementById("copy").onclick = async () => {
  const msg = document.getElementById("msg");
  const src = document.getElementById("copyFrom").value;
  const { settings } = await areas[src].get("settings");
  if (!isConfigured(settings)) {
    msg.textContent = "That site has no API key and resume yet.";
    return;
  }
  const shared = {};
  for (const k of SHARED) if (k in settings) shared[k] = settings[k];
  for (const s of JF_SUBS) {
    if (s.id === src) continue;
    const cur = (await areas[s.id].get("settings")).settings || {};
    // scoreCache is cleared like the sub-extensions' own Save button does
    await areas[s.id].set({ settings: { ...cur, ...shared }, scoreCache: {} });
  }
  msg.textContent = "Copied.";
  render();
};

render();

// ---------- job tracker ----------
async function renderTracker() {
  const all = await JFTracker.all();
  const list = JFTracker.search(all, document.getElementById("tq").value);
  const body = document.querySelector("#records tbody");
  body.textContent = "";
  for (const r of list.slice(0, 500)) {
    const tr = document.createElement("tr");
    const job = document.createElement("td");
    const t = r.url ? Object.assign(document.createElement("a"), { href: r.url, target: "_blank", textContent: r.title }) : document.createTextNode(r.title);
    const co = Object.assign(document.createElement("div"), { className: "co", textContent: r.company || "" });
    job.append(t, co);
    const site = Object.assign(document.createElement("td"), { textContent: r.siteName || r.site || "" });
    const ai = Object.assign(document.createElement("td"), { textContent: r.score != null ? r.score : "", title: r.reason || "" });
    const st = document.createElement("td");
    const sel = document.createElement("select");
    for (const s of JFTracker.STATUSES) sel.append(Object.assign(document.createElement("option"), { value: s, textContent: s }));
    sel.value = r.status || "Matched";
    sel.onchange = () => JFTracker.update(r.id, { status: sel.value }).then(renderTracker);
    st.append(sel);
    const nt = document.createElement("td");
    const notes = Object.assign(document.createElement("input"), { className: "notes", value: r.notes || "" });
    notes.onchange = () => JFTracker.update(r.id, { notes: notes.value });
    nt.append(notes);
    const up = Object.assign(document.createElement("td"), { textContent: new Date(r.updatedAt || r.createdAt || 0).toLocaleDateString() });
    const dt = document.createElement("td");
    const del = Object.assign(document.createElement("button"), { className: "del", textContent: "✕", title: "Delete this record" });
    del.onclick = () => confirm(`Delete "${r.title}"?`) && JFTracker.remove(r.id).then(renderTracker);
    dt.append(del);
    tr.append(job, site, ai, st, nt, up, dt);
    body.append(tr);
  }
  document.getElementById("tcount").textContent = `${list.length} of ${all.length} record(s)` + (list.length > 500 ? " (first 500 shown)" : "");
}
document.getElementById("tq").addEventListener("input", renderTracker);
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch[JFTracker.KEY] && document.activeElement?.className !== "notes") renderTracker();
});
renderTracker();
