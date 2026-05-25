# Mysterium VPN Firefox Port (Broken)

This repository contains an attempt to port the [Mysterium VPN Chrome Extension](https://chromewebstore.google.com/detail/mysterium-vpn-for-chrome/dcljfnhbjpilfpmimipcijgaalcabfhd?hl=en&pli=1) to Firefox.

## Current Status: Broken ⚠️

The extension currently installs and the background scripts load without issue, but the **popup is broken**. 

When the extension icon is clicked, the popup appears for a single frame and then disappears instantly. This is because the UI is a compiled Flutter Web bundle (`main.dart.js`) that immediately executes synchronous calls expecting specific `chrome.*` APIs (such as `chrome.proxy.settings`). When it hits an unhandled error during its initialization, the JavaScript runtime in the popup crashes, causing Firefox to aggressively destroy the popup window.

### What has been done:
- Migrated the extension to Manifest V3 for Firefox compatibility (bumped `strict_min_version`).
- Created a `firefox-polyfill.js` file to attempt to map `chrome.proxy.settings` to `browser.proxy.settings`.
- Added global error catchers to `localStorage` and `browser.storage.local` to diagnose why Flutter crashes the window.

### What needs to be fixed:
Further debugging is required to capture the exact exception that Flutter is throwing inside the popup runtime before the window is destroyed. It is highly likely the Flutter app requires additional mock APIs or asynchronous initialization patterns that aren't natively supported by Firefox's popup container.
