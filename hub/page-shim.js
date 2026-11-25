// Loaded before a sub-extension's content script or options page (see manifest.json and
// generated/<id>/options.html). It points chrome.storage.local and chrome.storage.onChanged at
// that sub-extension's own namespace. generated/<id>/ns.js then calls __jfUseNamespace("<id>").
(() => {
  if (globalThis.__jfUseNamespace) return;
  globalThis.__jfUseNamespace = function (ns) {
    if (globalThis.__jfNamespace) {
      if (globalThis.__jfNamespace !== ns) {
        console.warn("[Job Filter Hub] storage already bound to", globalThis.__jfNamespace, "- ignoring", ns);
      }
      return;
    }
    globalThis.__jfNamespace = ns;
    const storage = chrome.storage;
    // snapshot the real methods first, so the fallback below can't call itself
    const L = storage.local;
    const E = storage.onChanged;
    const realLocal = {
      get: L.get.bind(L),
      set: L.set.bind(L),
      remove: L.remove.bind(L),
      getBytesInUse: L.getBytesInUse.bind(L),
      QUOTA_BYTES: L.QUOTA_BYTES
    };
    const realEvent = { addListener: E.addListener.bind(E), removeListener: E.removeListener.bind(E) };
    const area = globalThis.__jfMakeStorageArea(realLocal, ns);
    const onChanged = globalThis.__jfMakeOnChanged(realEvent, ns);
    const replace = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: true });
        if (obj[key] === value) return true;
      } catch {}
      try {
        obj[key] = value;
        return obj[key] === value;
      } catch {
        return false;
      }
    };
    if (!replace(storage, "local", area)) {
      // fall back to swapping the methods on the real StorageArea object
      for (const m of ["get", "set", "remove", "clear", "getBytesInUse"]) replace(storage.local, m, area[m]);
    }
    if (!replace(storage, "onChanged", onChanged)) {
      for (const m of ["addListener", "removeListener", "hasListener"]) replace(storage.onChanged, m, onChanged[m]);
    }
  };
})();
