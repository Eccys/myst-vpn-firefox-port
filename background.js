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

function parseProxyHostAndPort(rawHost, defaultPort = 443) {
    let host = String(rawHost || "").trim();
    let port = defaultPort;
    if (!host) {
        return { host: "", port };
    }

    // Strip leading scheme if present (e.g. "https://proxy.example.com:8443/path")
    host = host.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").replace(/\/.*$/, "");

    if (host.startsWith("[")) {
        const closeIdx = host.indexOf("]");
        if (closeIdx !== -1) {
            const ipv6Host = host.slice(1, closeIdx);
            const rest = host.slice(closeIdx + 1);
            if (rest.startsWith(":")) {
                const parsedPort = Number(rest.slice(1));
                if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
                    port = parsedPort;
                }
            }
            return { host: ipv6Host, port };
        }
    }

    const firstColon = host.indexOf(":");
    const lastColon = host.lastIndexOf(":");
    if (firstColon !== -1 && firstColon === lastColon) {
        // Single colon: host:port
        const parsedPort = Number(host.slice(lastColon + 1));
        if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
            port = parsedPort;
        }
        host = host.slice(0, lastColon);
    }

    return { host, port };
}

let isProxyControlled = false;

function isValidIpv4Octets(parts) {
    return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function shouldBypassProxy(rawHostname, activeProxyHost) {
    const hostname = String(rawHostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!hostname) return true;
    if (activeProxyHost && hostname === String(activeProxyHost).trim().toLowerCase().replace(/^\[|\]$/g, "")) {
        return true;
    }
    if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname === "localhost.localdomain" ||
        hostname.endsWith(".localhost.localdomain") ||
        hostname.endsWith(".local") ||
        hostname === "0.0.0.0" ||
        hostname === "::1" ||
        hostname === "0:0:0:0:0:0:0:1" ||
        hostname.startsWith("fe80:") ||
        hostname.startsWith("fc00:") ||
        hostname.startsWith("fd00:") ||
        hostname === "mysteriumvpn.com" ||
        hostname.endsWith(".mysteriumvpn.com") ||
        hostname === "mysterium.network" ||
        hostname.endsWith(".mysterium.network")
    ) {
        return true;
    }

    const ipv4Parts = hostname.split(".");
    if (isValidIpv4Octets(ipv4Parts)) {
        const [a, b] = ipv4Parts.map(Number);
        if (
            a === 0 ||
            a === 127 ||
            a === 10 ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31)
        ) {
            return true;
        }
    }
    return false;
}

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([KEY_PROXY_CONFIG, "__myst_firefox_proxy_state"]).then((result) => {
        const rawVal = result && result[KEY_PROXY_CONFIG];
        proxyConfig = readProxyConfigFromJson(rawVal ? String(rawVal) : null);
        const storedProxyState = result && result.__myst_firefox_proxy_state;
        const explicitlyDisconnected =
            storedProxyState &&
            typeof storedProxyState === "object" &&
            storedProxyState.levelOfControl &&
            storedProxyState.levelOfControl !== "controlled_by_this_extension";
        if (proxyConfig && proxyConfig.config && proxyConfig.config.host && !explicitlyDisconnected) {
            isProxyControlled = true;
        }
        console.debug(`chrome.storage: initial proxy configuration ${printProxyConfig(proxyConfig)}`);
    }).catch((err) => {
        console.warn("chrome.storage: failed to read initial proxy configuration", err);
    });
}

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
    isProxyControlled = Boolean(proxyConfig && proxyConfig.config && proxyConfig.config.host);
    console.debug(`chrome.storage.onChanged: [${KEY_PROXY_CONFIG}] new proxy configuration: ${printProxyConfig(proxyConfig)}`);

    triggerAuthListener();
}

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(proxyConfigStorageWatcher);
}

// Firefox native proxy.onRequest handler (works without requiring Private Browsing permission)
if (typeof browser !== "undefined" && browser.proxy && browser.proxy.onRequest) {
    browser.proxy.onRequest.addListener(
        (requestDetails) => {
            if (!isProxyControlled || !proxyConfig || !proxyConfig.config || !proxyConfig.config.host) {
                return { type: "direct" };
            }
            const { host, port } = parseProxyHostAndPort(proxyConfig.config.host);
            if (!host) {
                return { type: "direct" };
            }
            try {
                const reqUrl = new URL(requestDetails.url);
                if (shouldBypassProxy(reqUrl.hostname, host)) {
                    return { type: "direct" };
                }
            } catch (_) {}

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
    if (details && details.isProxy === true && isProxyControlled && proxyConfig && proxyConfig.config != null) {
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

if (typeof chrome !== "undefined" && chrome.webRequest && chrome.webRequest.onAuthRequired) {
    if (chrome.webRequest.onAuthRequired.hasListener(proxyAuthenticationProvider)) {
        console.debug("chrome.webRequest.onAuthRequired: removing existing listener");
        chrome.webRequest.onAuthRequired.removeListener(proxyAuthenticationProvider);
    }
    console.debug("chrome.webRequest.onAuthRequired: adding listener");
    chrome.webRequest.onAuthRequired.addListener(proxyAuthenticationProvider, { urls: ["<all_urls>"] }, ["asyncBlocking"]);
}

function iconUpdater(details) {
    if (details && details.levelOfControl === "controlled_by_this_extension") {
        isProxyControlled = true;
        if (typeof chrome !== "undefined" && chrome.action && chrome.action.setIcon) {
            chrome.action.setIcon({ path: "/icons/connected-48.png" });
        }
    } else {
        isProxyControlled = false;
        if (typeof chrome !== "undefined" && chrome.action && chrome.action.setIcon) {
            chrome.action.setIcon({ path: "/icons/default-48.png" });
        }
    }
}

if (typeof chrome !== "undefined" && chrome.proxy && chrome.proxy.settings) {
    chrome.proxy.settings.onChange.addListener(iconUpdater);
    chrome.proxy.settings.get({}, iconUpdater);
}

// Hack: triggers onAuthRequired listener.
// Without it, location update upon connecting within the extension popup won't work.
async function triggerAuthListener() {
    if (typeof fetch !== "function") return;
    return fetch(PING_URL)
        .then(res => console.debug(`Ping ${PING_URL}: ok ${res.status}`))
        .catch(err => console.debug(`Ping ${PING_URL} failed:`, err && err.message));
}

// Also do it on startup (fix broken connection if proxy had been activated in the previous browser session)
if (typeof chrome !== "undefined" && chrome.storage) {
    triggerAuthListener();
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        readProxyConfigFromJson,
        parseProxyHostAndPort,
        shouldBypassProxy,
        printProxyConfig,
        proxyAuthenticationProvider
    };
}
