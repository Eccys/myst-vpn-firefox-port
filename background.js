const KEY_PROXY_CONFIG = "proxy.config";
const PING_URL = "https://www.bing.com";

let proxyConfig = {
    username: "", // auth: from supervpn
    password: "", // auth: from supervpn
    country: "",  // selected country (code or null): set from client
    config: null, // actual proxy config: from supervpn
}

function printProxyConfig(proxyConfig) {
    if (proxyConfig == null) {
        return `(empty)`;
    }
    return `(country: ${proxyConfig.country}, username: ${proxyConfig.username}, password: ${proxyConfig.password})`;
}

function readProxyConfigFromJson(json) {
    let config;
    try {
        config = JSON.parse(json);
    } catch (e) {
        return null;
    }
    const username = config.username;
    const password = config.password;
    const country = config.country;
    return {username, password, country, config};
}

chrome.storage.local.get([KEY_PROXY_CONFIG]).then((result) => {
    const configJson = String(result[KEY_PROXY_CONFIG]);
    proxyConfig = readProxyConfigFromJson(configJson)
    console.debug(`chrome.storage: initial proxy configuration ${printProxyConfig(proxyConfig)}`)
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
    proxyConfig = readProxyConfigFromJson(configJson);
    console.debug(`chrome.storage.onChanged: [${KEY_PROXY_CONFIG}] new proxy configuration: ${printProxyConfig(proxyConfig)}`);

    triggerAuthListener();
}

chrome.storage.onChanged.addListener(proxyConfigStorageWatcher);

function proxyAuthenticationProvider(details, callback) {
    console.debug('chrome.webRequest.onAuthRequired: callback', JSON.stringify(details));
    if (details.isProxy === true && proxyConfig.config != null) {
        console.debug(`chrome.webRequest.onAuthRequired: providing proxy authentication: ${printProxyConfig(proxyConfig)}`);
        const authCredentials = {
            username: proxyConfig.username, password: proxyConfig.password,
        };
        callback({authCredentials});
    } else {
        console.debug('chrome.webRequest.onAuthRequired: not a proxy request or config not available');
        callback();
    }
}

if (chrome.webRequest.onAuthRequired.hasListener(proxyAuthenticationProvider)) {
    console.debug('chrome.webRequest.onAuthRequired: removing existing listener')
    chrome.webRequest.onAuthRequired.removeListener(proxyAuthenticationProvider);
}
console.debug('chrome.webRequest.onAuthRequired: adding listener')
chrome.webRequest.onAuthRequired.addListener(proxyAuthenticationProvider, {urls: ["<all_urls>"]}, ['asyncBlocking']);

function iconUpdater(details) {
    if (details.levelOfControl === "controlled_by_this_extension") {
        chrome.action.setIcon({path: "/icons/connected-48.png"});
    } else {
        chrome.action.setIcon({path: "/icons/default-48.png"})
    }
}

chrome.proxy.settings.onChange.addListener(iconUpdater)
chrome.proxy.settings.get({}, iconUpdater)

// Hack: triggers onAuthRequired listener.
// Without it, location update upon connecting within the extension popup won't work.
async function triggerAuthListener() {
    return fetch(PING_URL).then(res => console.debug(`Ping ${PING_URL}: ok ${res.status}`));
}

// Also do it on startup (fix broken connection if proxy had been activated in the previous browser session)
triggerAuthListener()
