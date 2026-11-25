// Background router: one service worker hosts all bundled sub-extensions.
// Each sub-extension's background.js runs inside its own function scope (see generated/<id>/background.js)
// and gets its own `chrome` object from __jfMakeChrome(id), which differs from the real one only here:
//   - chrome.action.onClicked: the toolbar click goes only to the sub-extension of the active tab's site
//   - chrome.runtime.onMessage: only messages whose type starts with the sub-extension's prefix
//   - chrome.runtime.openOptionsPage(): opens that sub-extension's own settings page
//   - chrome.scripting.executeScript({files}): file paths point into extensions/<id>/
//   - chrome.storage.local / onChanged: that sub-extension's own storage namespace
// Everything else is the real chrome API.
(() => {
  const real = globalThis.chrome;
  const subs = Object.fromEntries(JF_SUBS.map((s) => [s.id, { ...s, re: new RegExp(s.match, "i"), clicks: [] }]));
  const HUB_PAGE = "hub/hub.html";
  const PAGE_SHIM = ["hub/storage-ns.js", "hub/page-shim.js"];

  function subForUrl(url) {
    return Object.values(subs).find((s) => s.re.test(url || ""));
  }

  async function openPage(path) {
    const url = real.runtime.getURL(path);
    try {
      const [t] = await real.tabs.query({ url: url.split(/[?#]/)[0] + "*" });
      if (t) {
        await real.tabs.update(t.id, { active: true, url });
        await real.windows.update(t.windowId, { focused: true });
        return;
      }
    } catch {}
    await real.tabs.create({ url });
  }
  globalThis.__jfOpenPage = openPage;

  // ---------- toolbar button ----------
  const MAIL_RE = /^https:\/\/mail\.google\.com\//;
  function handleClick(tab) {
    if (MAIL_RE.test((tab && tab.url) || "")) {
      // Gmail: show/hide the job tracker menu (hub/mail.js); inject it if the tab was open before install
      real.tabs.sendMessage(tab.id, { type: "HUB_TRACKER_TOGGLE" }).catch(async () => {
        await real.scripting.executeScript({ target: { tabId: tab.id }, files: ["hub/tracker-store.js", "hub/mail.js"] });
        await real.tabs.sendMessage(tab.id, { type: "HUB_TRACKER_TOGGLE" });
      }).catch((e) => console.error("[tracker]", e));
      return;
    }
    const sub = subForUrl(tab && tab.url);
    if (!sub || !sub.clicks.length) {
      openPage(HUB_PAGE);
      return;
    }
    for (const fn of sub.clicks) {
      try {
        const r = fn(tab);
        if (r && r.catch) r.catch((e) => console.error(`[${sub.id}]`, e));
      } catch (e) {
        console.error(`[${sub.id}]`, e);
      }
    }
  }
  real.action.onClicked.addListener(handleClick);

  // ---------- hub messages (from hub/mail.js) ----------
  real.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "HUB_OPEN_TRACKER") openPage(HUB_PAGE + "#tracker");
  });
  globalThis.__jfHandleClick = handleClick; // for tests

  // ---------- per-sub chrome object ----------
  function overlay(target, overrides) {
    return new Proxy(target, {
      get(t, k) {
        if (Object.prototype.hasOwnProperty.call(overrides, k)) return overrides[k];
        const v = t[k];
        return typeof v === "function" ? v.bind(t) : v;
      }
    });
  }

  globalThis.__jfMakeChrome = function (id) {
    const sub = subs[id];
    const messageWrappers = new Map();

    const onClicked = {
      addListener: (fn) => sub.clicks.includes(fn) || sub.clicks.push(fn),
      removeListener: (fn) => (sub.clicks = sub.clicks.filter((f) => f !== fn)),
      hasListener: (fn) => sub.clicks.includes(fn)
    };

    const onMessage = {
      addListener(fn) {
        if (messageWrappers.has(fn)) return;
        const w = (msg, sender, sendResponse) => {
          if (!msg || typeof msg.type !== "string" || !msg.type.startsWith(sub.prefix)) return undefined;
          let respond = sendResponse;
          // A job the AI calls a match goes into the job tracker (not the options page's "Test")
          if (msg.type === sub.prefix + "SCORE" && msg.job && sender && sender.tab && !/^chrome-extension:/.test(sender.url || "")) {
            respond = (resp) => {
              try {
                if (resp && resp.ok && resp.result && resp.result.decision === "match") globalThis.JFTracker.recordMatch(sub, msg.job, resp.result, sender);
              } catch (e) {
                console.error("[tracker]", e);
              }
              return sendResponse(resp);
            };
          }
          return fn(msg, sender, respond);
        };
        messageWrappers.set(fn, w);
        real.runtime.onMessage.addListener(w);
      },
      removeListener(fn) {
        const w = messageWrappers.get(fn);
        if (w) real.runtime.onMessage.removeListener(w);
        messageWrappers.delete(fn);
      },
      hasListener: (fn) => messageWrappers.has(fn)
    };

    function mapFiles(files) {
      const out = [];
      for (const f of files) {
        const name = String(f).replace(/^\.?\//, "");
        if (name === "content.js") out.push(...PAGE_SHIM, `generated/${id}/ns.js`);
        out.push(`extensions/${id}/${name}`);
      }
      return out;
    }

    function executeScript(injection, cb) {
      const inj = injection && injection.files ? { ...injection, files: mapFiles(injection.files) } : injection;
      return real.scripting.executeScript(inj, cb);
    }

    function openOptionsPage(cb) {
      const p = openPage(`generated/${id}/options.html`);
      if (typeof cb === "function") p.then(() => cb());
      return p;
    }

    return overlay(real, {
      action: overlay(real.action, { onClicked }),
      runtime: overlay(real.runtime, { onMessage, openOptionsPage }),
      scripting: overlay(real.scripting, { executeScript }),
      storage: overlay(real.storage, {
        local: globalThis.__jfMakeStorageArea(real.storage.local, id),
        onChanged: globalThis.__jfMakeOnChanged(real.storage.onChanged, id)
      })
    });
  };
})();
