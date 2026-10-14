# Mysterium VPN Firefox Port

This repository contains a working port of the [Mysterium VPN Chrome Extension](https://chromewebstore.google.com/detail/mysterium-vpn-for-chrome/dcljfnhbjpilfpmimipcijgaalcabfhd?hl=en&pli=1) to Firefox (Manifest V3).

## Status: Fixed ✅

### Root Causes Identified & Fixed
1. **Flutter `package_info_plus` Web Crash on `moz-extension://` Scheme (`main.dart.js`)**:
   - During startup (`main()`), the Flutter bundle waits on `GetIt.I.allReady()` (which resolves `PackageInfo.fromPlatform()`) before invoking `runApp()`.
   - In `main.dart.js`, the URL origin helper (`bhP(a)`) checked `if (a.uf("chrome-extension"))` and otherwise called `a.gyA(a)` (`Uri.origin`).
   - Because Firefox extension pages run under `moz-extension://<uuid>/index.html`, `a.uf("chrome-extension")` returned `false` and `Uri.origin` threw `StateError: Bad state: Origin is only applicable to schemes http and https: moz-extension://...`, aborting `main()` before `runApp()` could ever mount the Flutter UI.
   - Updated `bhP(a)` in `main.dart.js` to accept both `"chrome-extension"` and `"moz-extension"`.

2. **Firefox `browser.proxy.settings` Schema Validation & Permission Restrictions (`firefox-polyfill.js`, `background.js`)**:
   - The compiled Dart `chrome_extension` interop calls `chrome.proxy.settings.get({ incognito: null })`, `chrome.proxy.settings.set({ value, scope: "regular" })`, and `chrome.proxy.settings.clear({ scope: null })`.
   - Firefox's `browser.proxy.settings` (`BrowserSetting`) throws synchronous `TypeError` exceptions when passed `incognito: null` or any `scope` property, and `singleProxy` in `main.dart.js` omits `port` (which previously produced `https://<host>:undefined`).
   - Furthermore, `browser.proxy.settings.set` in Firefox requires Private Browsing extension access, whereas `browser.proxy.onRequest` does not.
   - Updated `firefox-polyfill.js` and `background.js` to sanitize parameters, parse `host:port` with default HTTPS port `443`, synchronize `levelOfControl` (`controllable_by_this_extension` / `controlled_by_this_extension`) via `browser.storage.local`, and route proxy traffic via `browser.proxy.onRequest`.

3. **Null Dereference in `background.js`**:
   - Fixed `proxyAuthenticationProvider` throwing `TypeError: can't access property "config", proxyConfig is null` when `proxy.config` is not yet set in `storage.local`.
