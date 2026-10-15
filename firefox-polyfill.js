/**
 * Firefox extension compatibility polyfill for Mysterium VPN.
 * Polyfills chrome.runtime, chrome.storage.local, and chrome.proxy.settings
 * using Firefox WebExtensions APIs (browser.storage.local, browser.proxy.settings,
 * and browser.proxy.onRequest state synchronization).
 */
(function () {
  const global = typeof globalThis !== "undefined" ? globalThis : self;
  const PROXY_STATE_STORAGE_KEY = "__myst_firefox_proxy_state";

  function recordDiagnosticError(type, msg, stack) {
    try {
      if (typeof localStorage !== "undefined") {
        const errors = JSON.parse(localStorage.getItem("myst_errors") || "[]");
        errors.push({ type, time: Date.now(), msg, stack });
        localStorage.setItem("myst_errors", JSON.stringify(errors.slice(-50)));
      }
    } catch (_) {}
  }

  global.addEventListener("error", function (e) {
    const errStr = "Error: " + e.message + " at " + e.filename + ":" + e.lineno;
    console.error("[Mysterium Firefox Polyfill] Global error:", errStr);
    recordDiagnosticError("error", errStr);
  });

  global.addEventListener("unhandledrejection", function (e) {
    const errStr = "Unhandled Rejection: " + (e.reason ? e.reason.toString() : "unknown");
    console.error("[Mysterium Firefox Polyfill] Unhandled rejection:", errStr);
    recordDiagnosticError("unhandledrejection", errStr, e.reason && e.reason.stack);
  });

  function safeDefine(obj, prop, value) {
    if (!obj) return false;
    try {
      obj[prop] = value;
      if (obj[prop] === value) return true;
    } catch (_) {}
    try {
      Object.defineProperty(obj, prop, {
        value: value,
        writable: true,
        configurable: true,
        enumerable: true
      });
      return true;
    } catch (e2) {
      console.error(`[Mysterium Firefox Polyfill] Failed to define property "${prop}"`, e2);
      return false;
    }
  }

  const nativeBrowser = typeof global.browser !== "undefined" ? global.browser : null;

  if (nativeBrowser && typeof global.chrome === "undefined") {
    safeDefine(global, "chrome", {});
  }

  if (typeof global.chrome === "undefined") {
    return;
  }

  // 1. Ensure chrome.runtime, chrome.runtime.id, chrome.action, and chrome.webRequest exist
  if (!global.chrome.runtime) {
    safeDefine(global.chrome, "runtime", (nativeBrowser && nativeBrowser.runtime) || {});
  }
  if (!global.chrome.runtime.id) {
    const fallbackId =
      (nativeBrowser && nativeBrowser.runtime && nativeBrowser.runtime.id) ||
      "mysterium-vpn@mysterium.network";
    safeDefine(global.chrome.runtime, "id", fallbackId);
  }
  if (!global.chrome.action && nativeBrowser && nativeBrowser.action) {
    safeDefine(global.chrome, "action", nativeBrowser.action);
  }
  if (!global.chrome.webRequest && nativeBrowser && nativeBrowser.webRequest) {
    safeDefine(global.chrome, "webRequest", nativeBrowser.webRequest);
  }

  // 2. Ensure chrome.storage.local methods always return Promises AND support callbacks
  if (nativeBrowser && nativeBrowser.storage && nativeBrowser.storage.local) {
    const rawLocal = nativeBrowser.storage.local;
    const wrappedLocal = {
      get: function (keys, callback) {
        const promise = rawLocal.get(keys === undefined ? null : keys);
        if (typeof callback === "function") {
          promise.then((res) => callback(res)).catch(() => callback({}));
        }
        return promise;
      },
      set: function (items, callback) {
        const promise = rawLocal.set(items || {});
        if (typeof callback === "function") {
          promise.then(() => callback()).catch(() => callback());
        }
        return promise;
      },
      remove: function (keys, callback) {
        const promise = rawLocal.remove(keys);
        if (typeof callback === "function") {
          promise.then(() => callback()).catch(() => callback());
        }
        return promise;
      },
      clear: function (callback) {
        const promise = rawLocal.clear();
        if (typeof callback === "function") {
          promise.then(() => callback()).catch(() => callback());
        }
        return promise;
      }
    };

    if (!global.chrome.storage) {
      safeDefine(global.chrome, "storage", {
        local: wrappedLocal,
        onChanged: nativeBrowser.storage.onChanged
      });
    } else {
      safeDefine(global.chrome.storage, "local", wrappedLocal);
      if (!global.chrome.storage.onChanged && nativeBrowser.storage.onChanged) {
        safeDefine(global.chrome.storage, "onChanged", nativeBrowser.storage.onChanged);
      }
    }
  }

  // 3. Polyfill chrome.proxy.settings with Chrome-compatible state & Firefox translation
  const onChangeListeners = new Set();

  let cachedProxyState = {
    levelOfControl: "controllable_by_this_extension",
    value: { mode: "system" }
  };

  function notifyProxyChange(newState) {
    cachedProxyState = newState;
    for (const listener of Array.from(onChangeListeners)) {
      try {
        listener(newState);
      } catch (err) {
        console.error("[Mysterium Firefox Polyfill] Error in proxy.settings.onChange listener:", err);
      }
    }
  }

  async function readStoredProxyState() {
    if (nativeBrowser && nativeBrowser.storage && nativeBrowser.storage.local) {
      try {
        const res = await nativeBrowser.storage.local.get(PROXY_STATE_STORAGE_KEY);
        const stored = res && res[PROXY_STATE_STORAGE_KEY];
        if (stored && typeof stored === "object" && stored.levelOfControl) {
          cachedProxyState = stored;
          return stored;
        }
      } catch (_) {}
    }
    return cachedProxyState;
  }

  async function writeStoredProxyState(newState) {
    cachedProxyState = newState;
    if (nativeBrowser && nativeBrowser.storage && nativeBrowser.storage.local) {
      try {
        await nativeBrowser.storage.local.set({ [PROXY_STATE_STORAGE_KEY]: newState });
      } catch (_) {}
    }
    notifyProxyChange(newState);
  }

  if (nativeBrowser && nativeBrowser.storage && nativeBrowser.storage.onChanged) {
    nativeBrowser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[PROXY_STATE_STORAGE_KEY] && changes[PROXY_STATE_STORAGE_KEY].newValue) {
        notifyProxyChange(changes[PROXY_STATE_STORAGE_KEY].newValue);
      }
    });
  }

  function parseHostAndPort(rawHost, rawPort, scheme) {
    let host = String(rawHost || "").trim();
    host = host.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").replace(/\/.*$/, "");

    const parsedRawPort = rawPort != null && rawPort !== "" ? Number(rawPort) : null;
    let port =
      Number.isInteger(parsedRawPort) && parsedRawPort >= 1 && parsedRawPort <= 65535
        ? parsedRawPort
        : null;

    if (host.startsWith("[")) {
      const closeIdx = host.indexOf("]");
      if (closeIdx !== -1) {
        const ipv6Host = host.slice(1, closeIdx);
        const rest = host.slice(closeIdx + 1);
        if (rest.startsWith(":")) {
          const maybePort = Number(rest.slice(1));
          if (!port && Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
            port = maybePort;
          }
        }
        host = ipv6Host;
      }
    } else {
      const firstColon = host.indexOf(":");
      const lastColon = host.lastIndexOf(":");
      if (firstColon !== -1 && firstColon === lastColon) {
        const maybePort = Number(host.slice(lastColon + 1));
        if (Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
          if (!port) port = maybePort;
        }
        host = host.slice(0, lastColon);
      }
    }

    if (!port) {
      port = scheme === "https" ? 443 : scheme && scheme.startsWith("socks") ? 1080 : 80;
    }
    return { host, port };
  }

  function translateChromeToFirefoxProxy(chromeValue) {
    const firefoxValue = {};
    if (!chromeValue || typeof chromeValue !== "object") {
      firefoxValue.proxyType = "system";
      return firefoxValue;
    }

    if (chromeValue.mode === "fixed_servers") {
      firefoxValue.proxyType = "manual";
      const singleProxy = chromeValue.rules && chromeValue.rules.singleProxy;
      if (singleProxy && singleProxy.host) {
        const scheme = String(singleProxy.scheme || "https").toLowerCase();
        const { host, port } = parseHostAndPort(singleProxy.host, singleProxy.port, scheme);
        const formattedHost = host.includes(":") ? `[${host}]` : host;
        const hostPort = `${formattedHost}:${port}`;

        if (scheme === "https" || scheme === "http") {
          firefoxValue.http = hostPort;
          firefoxValue.ssl = hostPort;
          firefoxValue.httpProxyAll = true;
        } else if (scheme.startsWith("socks")) {
          firefoxValue.socks = hostPort;
          firefoxValue.socksVersion = scheme === "socks4" ? 4 : 5;
        }
      }

      const bypassList = chromeValue.rules && chromeValue.rules.bypassList;
      if (Array.isArray(bypassList) && bypassList.length > 0) {
        firefoxValue.passthrough = bypassList.join(", ");
      }
    } else if (chromeValue.mode === "direct") {
      firefoxValue.proxyType = "none";
    } else if (chromeValue.mode === "auto_detect") {
      firefoxValue.proxyType = "autoDetect";
    } else {
      firefoxValue.proxyType = "system";
    }

    return firefoxValue;
  }

  const polyfillSettings = {
    set: function (details, callback) {
      const run = async () => {
        const chromeValue = (details && details.value) || { mode: "system" };
        const isFixed = chromeValue.mode === "fixed_servers";
        const newState = {
          levelOfControl: isFixed ? "controlled_by_this_extension" : "controllable_by_this_extension",
          value: chromeValue
        };

        await writeStoredProxyState(newState);

        // Attempt native browser.proxy.settings.set without invalid 'scope' property
        if (nativeBrowser && nativeBrowser.proxy && nativeBrowser.proxy.settings) {
          try {
            const firefoxValue = translateChromeToFirefoxProxy(chromeValue);
            await nativeBrowser.proxy.settings.set({ value: firefoxValue });
          } catch (err) {
            // In Firefox without Private Browsing access, proxy.settings.set throws;
            // background.js handles proxying via browser.proxy.onRequest instead.
            console.debug("[Mysterium Firefox Polyfill] browser.proxy.settings.set fallback to onRequest:", err && err.message);
          }
        }
      };

      const promise = run().catch((err) => {
        console.error("[Mysterium Firefox Polyfill] Error in proxy.settings.set:", err);
      });

      if (typeof callback === "function") {
        promise.then(() => callback());
      }
      return promise;
    },

    get: function (details, callback) {
      const run = async () => {
        const state = await readStoredProxyState();

        // Also check native browser.proxy.settings.get with sanitized details (no null incognito)
        if (nativeBrowser && nativeBrowser.proxy && nativeBrowser.proxy.settings) {
          try {
            const cleanDetails = {};
            if (details && typeof details.incognito === "boolean") {
              cleanDetails.incognito = details.incognito;
            }
            const nativeRes = await nativeBrowser.proxy.settings.get(cleanDetails);
            if (nativeRes && nativeRes.levelOfControl === "controlled_by_other_extensions") {
              return {
                levelOfControl: "controlled_by_other_extensions",
                value: state.value || { mode: "system" }
              };
            }
          } catch (_) {}
        }

        return state;
      };

      const promise = run().catch(() => cachedProxyState);

      if (typeof callback === "function") {
        promise.then((res) => callback(res));
      }
      return promise;
    },

    clear: function (_details, callback) {
      const run = async () => {
        const clearedState = {
          levelOfControl: "controllable_by_this_extension",
          value: { mode: "system" }
        };
        await writeStoredProxyState(clearedState);

        if (nativeBrowser && nativeBrowser.proxy && nativeBrowser.proxy.settings) {
          try {
            // Firefox BrowserSetting.clear() only accepts {} without 'scope'
            await nativeBrowser.proxy.settings.clear({});
          } catch (_) {}
        }
      };

      const promise = run().catch((err) => {
        console.error("[Mysterium Firefox Polyfill] Error in proxy.settings.clear:", err);
      });

      if (typeof callback === "function") {
        promise.then(() => callback());
      }
      return promise;
    },

    onChange: {
      addListener: function (callback) {
        if (typeof callback === "function") {
          onChangeListeners.add(callback);
        }
      },
      removeListener: function (callback) {
        onChangeListeners.delete(callback);
      },
      hasListener: function (callback) {
        return onChangeListeners.has(callback);
      }
    }
  };

  if (!global.chrome.proxy) {
    safeDefine(global.chrome, "proxy", {});
  }
  safeDefine(global.chrome.proxy, "settings", polyfillSettings);

  // Initialize cached state in background
  void readStoredProxyState();
})();
