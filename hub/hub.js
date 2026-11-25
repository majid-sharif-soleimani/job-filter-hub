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
