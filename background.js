const KEY_PROXY_CONFIG = "proxy.config";
const PING_URL = "https://www.bing.com";

let proxyConfig = {
    username: "", // auth: from supervpn
    password: "", // auth: from supervpn
    country: "",  // selected country (code or null): set from client
    config: null, // actual proxy config: from supervpn
};

function printProxyConfig(cfg) {
    if (cfg == null || cfg.config == null) {
        return `(empty)`;
    }
    return `(country: ${cfg.country}, username: ${cfg.username}, password: ${cfg.password})`;
}

function readProxyConfigFromJson(json) {
    if (!json || typeof json !== "string") {
        return { username: "", password: "", country: "", config: null };
    }
    try {
        const config = JSON.parse(json);
        if (!config || typeof config !== "object") {
            return { username: "", password: "", country: "", config: null };
        }
        const username = config.username || "";
        const password = config.password || "";
        const country = config.country || "";
        return { username, password, country, config };
    } catch (e) {
        return { username: "", password: "", country: "", config: null };
    }
}

function parseProxyHostAndPort(rawHost) {
    let host = String(rawHost || "").trim();
    let port = 443;
    if (host.includes(":")) {
        const idx = host.lastIndexOf(":");
        const parsedPort = Number(host.slice(idx + 1));
        if (Number.isInteger(parsedPort) && parsedPort > 0) {
            port = parsedPort;
        }
        host = host.slice(0, idx);
    }
    return { host, port };
}

chrome.storage.local.get([KEY_PROXY_CONFIG]).then((result) => {
    const rawVal = result && result[KEY_PROXY_CONFIG];
    proxyConfig = readProxyConfigFromJson(rawVal ? String(rawVal) : null);
    console.debug(`chrome.storage: initial proxy configuration ${printProxyConfig(proxyConfig)}`);
}).catch((err) => {
    console.warn("chrome.storage: failed to read initial proxy configuration", err);
});

function proxyConfigStorageWatcher(changes, _) {
    if (changes.myst_errors) {
        console.error("POPUP ERRORS:", changes.myst_errors.newValue);
    }
    const isProxyConfigChanged = !!changes[KEY_PROXY_CONFIG];
    if (!isProxyConfigChanged) {
        return;
    }
    const configJson = changes[KEY_PROXY_CONFIG]["newValue"];
    proxyConfig = readProxyConfigFromJson(configJson ? String(configJson) : null);
    console.debug(`chrome.storage.onChanged: [${KEY_PROXY_CONFIG}] new proxy configuration: ${printProxyConfig(proxyConfig)}`);

    triggerAuthListener();
}

chrome.storage.onChanged.addListener(proxyConfigStorageWatcher);

// Firefox native proxy.onRequest handler (works without requiring Private Browsing permission)
if (typeof browser !== "undefined" && browser.proxy && browser.proxy.onRequest) {
    browser.proxy.onRequest.addListener(
        (requestDetails) => {
            if (!proxyConfig || !proxyConfig.config || !proxyConfig.config.host) {
                return { type: "direct" };
            }
            try {
                const reqUrl = new URL(requestDetails.url);
                const hostname = reqUrl.hostname.toLowerCase();
                if (
                    hostname === "localhost" ||
                    hostname === "127.0.0.1" ||
                    hostname === "::1" ||
                    hostname.endsWith(".mysteriumvpn.com") ||
                    hostname.endsWith(".mysterium.network")
                ) {
                    return { type: "direct" };
                }
            } catch (_) {}

            const { host, port } = parseProxyHostAndPort(proxyConfig.config.host);
            if (!host) {
                return { type: "direct" };
            }
            return {
                type: "https",
                host,
                port
            };
        },
        { urls: ["<all_urls>"] }
    );
}

function proxyAuthenticationProvider(details, callback) {
    console.debug("chrome.webRequest.onAuthRequired: callback", JSON.stringify(details));
    if (details.isProxy === true && proxyConfig && proxyConfig.config != null) {
        console.debug(`chrome.webRequest.onAuthRequired: providing proxy authentication: ${printProxyConfig(proxyConfig)}`);
        const authCredentials = {
            username: proxyConfig.username,
            password: proxyConfig.password,
        };
        if (typeof callback === "function") {
            callback({ authCredentials });
            return;
        }
        return Promise.resolve({ authCredentials });
    } else {
        console.debug("chrome.webRequest.onAuthRequired: not a proxy request or config not available");
        if (typeof callback === "function") {
            callback();
            return;
        }
        return Promise.resolve({});
    }
}

if (chrome.webRequest.onAuthRequired.hasListener(proxyAuthenticationProvider)) {
    console.debug("chrome.webRequest.onAuthRequired: removing existing listener");
    chrome.webRequest.onAuthRequired.removeListener(proxyAuthenticationProvider);
}
console.debug("chrome.webRequest.onAuthRequired: adding listener");
chrome.webRequest.onAuthRequired.addListener(proxyAuthenticationProvider, { urls: ["<all_urls>"] }, ["asyncBlocking"]);

function iconUpdater(details) {
    if (details && details.levelOfControl === "controlled_by_this_extension") {
        chrome.action.setIcon({ path: "/icons/connected-48.png" });
    } else {
        chrome.action.setIcon({ path: "/icons/default-48.png" });
    }
}

chrome.proxy.settings.onChange.addListener(iconUpdater);
chrome.proxy.settings.get({}, iconUpdater);

// Hack: triggers onAuthRequired listener.
// Without it, location update upon connecting within the extension popup won't work.
async function triggerAuthListener() {
    return fetch(PING_URL)
        .then(res => console.debug(`Ping ${PING_URL}: ok ${res.status}`))
        .catch(err => console.debug(`Ping ${PING_URL} failed:`, err && err.message));
}

// Also do it on startup (fix broken connection if proxy had been activated in the previous browser session)
triggerAuthListener();
