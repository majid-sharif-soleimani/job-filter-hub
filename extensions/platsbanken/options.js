const $ = (id) => document.getElementById(id);
let state;

function showProvider() {
  const p = $("provider").value;
  $("model").value = state.models[p] || "";
  $("apiKey").value = state.apiKeys[p] || "";
}

function collect() {
  const p = $("provider").value;
  state.provider = p;
  state.models[p] = $("model").value.trim();
  state.apiKeys[p] = $("apiKey").value.trim();
  state.threshold = Math.max(0, Math.min(100, parseInt($("threshold").value, 10) || 0));
  state.delaySec = Math.max(0, parseFloat($("delaySec").value) || 0);
  state.dryRun = $("dryRun").checked;
  state.saveMatches = $("saveMatches").checked;
  state.openMode = $("openMode").value;
  state.markRejected = $("markRejected").value;
  state.showPrevious = $("showPrevious").checked;
  state.includeExternal = $("includeExternal").checked;
  state.readExternalSource = $("readExternalSource").checked;
  state.blockKeywords = $("blockKeywords").value;
  state.commuteLocations = $("commuteLocations").value;
  state.criteria = $("criteria").value;
  state.resume = $("resume").value;
}

async function save() {
  collect();
  // Resume/criteria may have changed, so old scores are no longer valid
  await chrome.storage.local.set({ settings: state, scoreCache: {} });
  msg("Saved ✔");
}

function msg(t, color = "#1e8e3e") {
  $("msg").textContent = t;
  $("msg").style.color = color;
}

(async () => {
  state = await afjfGetSettings();
  $("provider").value = state.provider;
  showProvider();
  $("threshold").value = state.threshold;
  $("delaySec").value = state.delaySec;
  $("dryRun").checked = state.dryRun;
  $("saveMatches").checked = state.saveMatches ?? true;
  $("openMode").value = state.openMode || "iframe";
  $("markRejected").value = state.markRejected || "dim";
  $("showPrevious").checked = state.showPrevious ?? true;
  $("includeExternal").checked = state.includeExternal ?? true;
  $("readExternalSource").checked = state.readExternalSource ?? true;
  showPermissionState();
  $("blockKeywords").value = state.blockKeywords || "";
  $("commuteLocations").value = state.commuteLocations ?? "";
  $("criteria").value = state.criteria;
  $("resume").value = state.resume;
  prevProvider = state.provider;
})();

// remember the model/key typed for the previous provider before switching
let prevProvider;
$("provider").addEventListener("change", () => {
  if (prevProvider) {
    state.models[prevProvider] = $("model").value.trim();
    state.apiKeys[prevProvider] = $("apiKey").value.trim();
  }
  prevProvider = $("provider").value;
  showProvider();
});

$("resumeFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) $("resume").value = await f.text();
});

// Reading external source sites needs the optional host permission for all sites.
// chrome.permissions.request must run directly in the click handler (user gesture), before any await.
const ALL_SITES = { origins: ["https://*/*", "http://*/*"] };
function askPermissionIfNeeded() {
  if (!$("readExternalSource").checked) return Promise.resolve(true);
  return chrome.permissions.request(ALL_SITES).catch(() => false);
}
async function showPermissionState() {
  const has = await chrome.permissions.contains(ALL_SITES).catch(() => false);
  $("permState").textContent = $("readExternalSource").checked && !has ? "⚠ Permission to read external sites not granted yet: press Save and allow it." : "";
}
$("readExternalSource").addEventListener("change", showPermissionState);

$("save").addEventListener("click", () => {
  askPermissionIfNeeded().then(async (ok) => {
    await save();
    if (!ok) msg("Saved, but without permission to read external sites (only their summary will be scored).", "#b06000");
    showPermissionState();
  });
});

$("test").addEventListener("click", async () => {
  const permOk = askPermissionIfNeeded();
  await permOk;
  await save();
  showPermissionState();
  msg("Testing…", "#555");
  const resp = await chrome.runtime.sendMessage({
    type: "AFJF_SCORE",
    job: {
      title: "Senior Backend Developer",
      company: "Test AB",
      cardText: "Senior Backend Developer | Test AB | Stockholm (Hybrid) | Systemutvecklare/Programmerare",
      detailText: "Om jobbet: Vi bygger backend-API:er i C#/.NET med PostgreSQL på AWS. Vi arbetar på engelska; svenska är meriterande."
    }
  });
  if (resp?.ok) msg(`API works ✔  Test job scored ${resp.result.score} (${resp.result.decision}): ${resp.result.reason}`);
  else msg("Failed: " + (resp?.error || "no response"), "#c5221f");
});
