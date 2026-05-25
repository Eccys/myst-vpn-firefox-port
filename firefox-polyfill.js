/**
 * Firefox extension compatibility polyfill for Mysterium VPN.
 * Polyfills chrome.proxy.settings using browser.proxy.settings.
 * Designed with robust try-catch boundaries and safe property definition
 * helpers to prevent startup crashes in Firefox host objects.
 */
(function () {
  const global = typeof globalThis !== 'undefined' ? globalThis : self;

  // Global error handlers for debugging
  global.addEventListener('error', function(e) {
    let errStr = "Error: " + e.message + " at " + e.filename + ":" + e.lineno;
    console.error("[Mysterium Firefox Polyfill] Global error:", errStr);
    let errors = JSON.parse(localStorage.getItem('myst_errors') || '[]');
    errors.push({type: 'error', time: Date.now(), msg: errStr});
    localStorage.setItem('myst_errors', JSON.stringify(errors));
    if (global.browser && global.browser.storage && global.browser.storage.local) {
      global.browser.storage.local.get('myst_errors').then(res => {
        let be = res.myst_errors || [];
        be.push({type: 'error', time: Date.now(), msg: errStr});
        global.browser.storage.local.set({myst_errors: be});
      });
    }
  });

  global.addEventListener('unhandledrejection', function(e) {
    let errStr = "Unhandled Rejection: " + (e.reason ? e.reason.toString() : "unknown");
    console.error("[Mysterium Firefox Polyfill] Unhandled rejection:", errStr);
    let errors = JSON.parse(localStorage.getItem('myst_errors') || '[]');
    errors.push({type: 'unhandledrejection', time: Date.now(), msg: errStr, stack: e.reason && e.reason.stack});
    localStorage.setItem('myst_errors', JSON.stringify(errors));
    if (global.browser && global.browser.storage && global.browser.storage.local) {
      global.browser.storage.local.get('myst_errors').then(res => {
        let be = res.myst_errors || [];
        be.push({type: 'unhandledrejection', time: Date.now(), msg: errStr, stack: e.reason && e.reason.stack});
        global.browser.storage.local.set({myst_errors: be});
      });
    }
  });

  // Helper to safely define properties on potentially read-only or host objects
  function safeDefine(obj, prop, value) {
    if (!obj) return false;
    try {
      obj[prop] = value;
      return true;
    } catch (e) {
      console.warn(`[Mysterium Firefox Polyfill] Direct assignment failed for property "${prop}", trying Object.defineProperty`, e);
      try {
        Object.defineProperty(obj, prop, {
          value: value,
          writable: true,
          configurable: true,
          enumerable: true
        });
        return true;
      } catch (e2) {
        console.error(`[Mysterium Firefox Polyfill] Failed to define property "${prop}" via Object.defineProperty`, e2);
        return false;
      }
    }
  }

  // 1. Ensure chrome namespace exists in Firefox
  if (typeof global.browser !== 'undefined' && typeof global.chrome === 'undefined') {
    safeDefine(global, 'chrome', global.browser);
  }

  if (typeof global.chrome !== 'undefined') {
    // 2. Polyfill chrome.proxy if it's missing (standard on Firefox)
    if (!global.chrome.proxy || !global.chrome.proxy.settings) {
      if (!global.chrome.proxy) {
        safeDefine(global.chrome, 'proxy', {});
      }
      console.log("[Mysterium Firefox Polyfill] Polyfilling chrome.proxy namespace");

      const polyfillSettings = {
        /**
         * Translates Chrome's proxy config to Firefox's proxy config
         * Chrome value: { mode: "fixed_servers", rules: { singleProxy: { scheme, host, port }, bypassList: [...] } }
         * Firefox value: { proxyType: "manual", http, ssl, httpProxyAll, passthrough }
         */
        set: function (details, callback) {
          console.debug("[Mysterium Firefox Polyfill] settings.set called", JSON.stringify(details));
          try {
            if (!global.browser || !global.browser.proxy || !global.browser.proxy.settings) {
              console.warn("[Mysterium Firefox Polyfill] browser.proxy.settings is unavailable");
              if (typeof callback === "function") {
                setTimeout(callback, 0);
              }
              return Promise.resolve();
            }

            const chromeValue = details.value;
            let firefoxValue = {};

            if (chromeValue.mode === "fixed_servers") {
              firefoxValue.proxyType = "manual";
              
              const singleProxy = chromeValue.rules && chromeValue.rules.singleProxy;
              if (singleProxy) {
                const scheme = singleProxy.scheme || "http";
                const host = singleProxy.host;
                const port = singleProxy.port;
                const proxyUrl = `${scheme}://${host}:${port}`;
                
                if (scheme === "https" || scheme === "http") {
                  firefoxValue.http = proxyUrl;
                  firefoxValue.ssl = proxyUrl;
                  firefoxValue.httpProxyAll = true;
                } else if (scheme.startsWith("socks")) {
                  firefoxValue.socks = proxyUrl;
                  firefoxValue.socksVersion = scheme === "socks4" ? 4 : 5;
                }
              }

              const bypassList = chromeValue.rules && chromeValue.rules.bypassList;
              if (bypassList) {
                firefoxValue.passthrough = bypassList.join(", ");
              }
            } else if (chromeValue.mode === "direct") {
              firefoxValue.proxyType = "none";
            } else if (chromeValue.mode === "system") {
              firefoxValue.proxyType = "system";
            } else if (chromeValue.mode === "auto_detect") {
              firefoxValue.proxyType = "autoDetect";
            } else {
              firefoxValue.proxyType = "system";
            }

            console.debug("[Mysterium Firefox Polyfill] Setting Firefox proxy config:", JSON.stringify(firefoxValue));
            const promise = global.browser.proxy.settings.set({
              value: firefoxValue,
              scope: details.scope || 'regular'
            });

            if (typeof callback === "function") {
              promise.then(() => callback()).catch((err) => {
                console.error("[Mysterium Firefox Polyfill] Error in proxy.settings.set:", err);
                callback();
              });
            }
            return promise;
          } catch (err) {
            console.error("[Mysterium Firefox Polyfill] Sync error in proxy.settings.set:", err);
            if (typeof callback === "function") {
              setTimeout(callback, 0);
            }
            return Promise.resolve(); // Resolve to prevent unhandled promise rejections
          }
        },

        get: function (details, callback) {
          console.debug("[Mysterium Firefox Polyfill] settings.get called");
          const defaultResult = { levelOfControl: "not_controllable", value: { mode: "system" } };
          try {
            if (!global.browser || !global.browser.proxy || !global.browser.proxy.settings) {
              console.warn("[Mysterium Firefox Polyfill] browser.proxy.settings is unavailable");
              if (typeof callback === "function") {
                setTimeout(() => callback(defaultResult), 0);
              }
              return Promise.resolve(defaultResult);
            }

            const promise = global.browser.proxy.settings.get(details || {});
            
            if (typeof callback === "function") {
              promise.then((result) => {
                console.debug("[Mysterium Firefox Polyfill] settings.get resolved:", JSON.stringify(result));
                callback(result);
              }).catch((err) => {
                console.error("[Mysterium Firefox Polyfill] Error in proxy.settings.get:", err);
                callback(defaultResult);
              });
            }
            return promise;
          } catch (err) {
            console.error("[Mysterium Firefox Polyfill] Sync error in proxy.settings.get:", err);
            if (typeof callback === "function") {
              setTimeout(() => callback(defaultResult), 0);
            }
            return Promise.resolve(defaultResult); // Resolve to prevent unhandled promise rejections
          }
        },

        clear: function (details, callback) {
          console.debug("[Mysterium Firefox Polyfill] settings.clear called");
          try {
            if (!global.browser || !global.browser.proxy || !global.browser.proxy.settings) {
              console.warn("[Mysterium Firefox Polyfill] browser.proxy.settings is unavailable");
              if (typeof callback === "function") {
                setTimeout(callback, 0);
              }
              return Promise.resolve();
            }

            const promise = global.browser.proxy.settings.clear(details || {});
            
            if (typeof callback === "function") {
              promise.then(() => callback()).catch((err) => {
                console.error("[Mysterium Firefox Polyfill] Error in proxy.settings.clear:", err);
                callback();
              });
            }
            return promise;
          } catch (err) {
            console.error("[Mysterium Firefox Polyfill] Sync error in proxy.settings.clear:", err);
            if (typeof callback === "function") {
              setTimeout(callback, 0);
            }
            return Promise.resolve(); // Resolve to prevent unhandled promise rejections
          }
        },

        onChange: {
          addListener: function (callback) {
            console.debug("[Mysterium Firefox Polyfill] settings.onChange.addListener registered");
            try {
              if (global.browser && global.browser.proxy && global.browser.proxy.settings && global.browser.proxy.settings.onChange) {
                global.browser.proxy.settings.onChange.addListener(callback);
              } else {
                console.warn("[Mysterium Firefox Polyfill] browser.proxy.settings.onChange is unavailable for addListener");
              }
            } catch (err) {
              console.error("[Mysterium Firefox Polyfill] Error in onChange.addListener:", err);
            }
          },
          removeListener: function (callback) {
            try {
              if (global.browser && global.browser.proxy && global.browser.proxy.settings && global.browser.proxy.settings.onChange) {
                global.browser.proxy.settings.onChange.removeListener(callback);
              }
            } catch (err) {
              console.error("[Mysterium Firefox Polyfill] Error in onChange.removeListener:", err);
            }
          },
          hasListener: function (callback) {
            try {
              if (global.browser && global.browser.proxy && global.browser.proxy.settings && global.browser.proxy.settings.onChange) {
                return global.browser.proxy.settings.onChange.hasListener(callback);
              }
            } catch (err) {
              console.error("[Mysterium Firefox Polyfill] Error in onChange.hasListener:", err);
            }
            return false;
          }
        }
      };

      safeDefine(global.chrome.proxy, 'settings', polyfillSettings);
    }
  }
})();
