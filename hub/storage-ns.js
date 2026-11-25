// Per-sub-extension storage namespaces.
// Every bundled extension stores its data under the same key names ("settings", "scoreCache",
// "autoNext", ...). Here each one gets its own prefix ("linkedin::settings"), so they never see
// or overwrite each other's data. The sub-extensions' code keeps calling chrome.storage.local
// exactly as before.
(() => {
  if (globalThis.__jfMakeStorageArea) return;
  const SEP = "::";

  function toPromise(p, cb) {
    if (typeof cb === "function") {
      p.then((v) => cb(v), () => cb(undefined));
      return undefined;
    }
    return p;
  }

  // A chrome.storage.StorageArea look-alike that reads and writes realArea under "<ns>::".
  globalThis.__jfMakeStorageArea = function (realArea, ns) {
    const pre = ns + SEP;
    const full = (k) => pre + k;
    const strip = (k) => k.slice(pre.length);
    const ours = (k) => typeof k === "string" && k.startsWith(pre);

    function get(keys, cb) {
      let p;
      if (keys === null || keys === undefined) {
        p = realArea.get(null).then((all) => {
          const out = {};
          for (const k of Object.keys(all)) if (ours(k)) out[strip(k)] = all[k];
          return out;
        });
      } else if (typeof keys === "string" || Array.isArray(keys)) {
        const list = typeof keys === "string" ? [keys] : keys;
        p = realArea.get(list.map(full)).then((got) => {
          const out = {};
          for (const k of list) if (full(k) in got) out[k] = got[full(k)];
          return out;
        });
      } else {
        // object form: { key: defaultValue }
        const defs = {};
        for (const k of Object.keys(keys)) defs[full(k)] = keys[k];
        p = realArea.get(defs).then((got) => {
          const out = {};
          for (const k of Object.keys(keys)) out[k] = got[full(k)];
          return out;
        });
      }
      return toPromise(p, cb);
    }

    function set(items, cb) {
      const real = {};
      for (const k of Object.keys(items || {})) real[full(k)] = items[k];
      return toPromise(realArea.set(real), cb);
    }

    function remove(keys, cb) {
      const list = typeof keys === "string" ? [keys] : keys || [];
      return toPromise(realArea.remove(list.map(full)), cb);
    }

    function clear(cb) {
      const p = realArea.get(null).then((all) => realArea.remove(Object.keys(all).filter(ours)));
      return toPromise(p, cb);
    }

    function getBytesInUse(keys, cb) {
      if (typeof keys === "function") (cb = keys), (keys = null);
      const p =
        keys === null || keys === undefined
          ? realArea.get(null).then((all) => realArea.getBytesInUse(Object.keys(all).filter(ours)))
          : realArea.getBytesInUse((typeof keys === "string" ? [keys] : keys).map(full));
      return toPromise(p, cb);
    }

    return { get, set, remove, clear, getBytesInUse, QUOTA_BYTES: realArea.QUOTA_BYTES };
  };

  // A chrome.storage.onChanged look-alike: listeners only hear about "<ns>::" keys of the
  // local area, with the prefix removed.
  globalThis.__jfMakeOnChanged = function (realEvent, ns) {
    const pre = ns + SEP;
    const wrapped = new Map();
    return {
      addListener(fn) {
        if (wrapped.has(fn)) return;
        const w = (changes, area) => {
          if (area !== "local") return fn(changes, area);
          const mine = {};
          let any = false;
          for (const k of Object.keys(changes)) {
            if (k.startsWith(pre)) {
              mine[k.slice(pre.length)] = changes[k];
              any = true;
            }
          }
          if (any) fn(mine, area);
        };
        wrapped.set(fn, w);
        realEvent.addListener(w);
      },
      removeListener(fn) {
        const w = wrapped.get(fn);
        if (w) realEvent.removeListener(w);
        wrapped.delete(fn);
      },
      hasListener(fn) {
        return wrapped.has(fn);
      }
    };
  };
})();
