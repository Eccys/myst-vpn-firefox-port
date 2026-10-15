const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  readProxyConfigFromJson,
  parseProxyHostAndPort,
  shouldBypassProxy
} = require('../background.js');

describe('myst-vpn-firefox-port background helpers (background.js)', () => {
  it('parses host and port across IPv4, domains, IPv6, scheme prefixes, and invalid ports', () => {
    assert.deepEqual(parseProxyHostAndPort('proxy.mysterium.network:8443'), {
      host: 'proxy.mysterium.network',
      port: 8443
    });
    assert.deepEqual(parseProxyHostAndPort('proxy.mysterium.network'), {
      host: 'proxy.mysterium.network',
      port: 443
    });
    assert.deepEqual(parseProxyHostAndPort('https://proxy.mysterium.network'), {
      host: 'proxy.mysterium.network',
      port: 443
    });
    assert.deepEqual(parseProxyHostAndPort('https://proxy.mysterium.network:9443/path'), {
      host: 'proxy.mysterium.network',
      port: 9443
    });
    assert.deepEqual(parseProxyHostAndPort('[2001:db8::1]:8443'), {
      host: '2001:db8::1',
      port: 8443
    });
    assert.deepEqual(parseProxyHostAndPort('[2001:db8::1]'), {
      host: '2001:db8::1',
      port: 443
    });
    assert.deepEqual(parseProxyHostAndPort('2001:db8::1'), {
      host: '2001:db8::1',
      port: 443
    });
    assert.deepEqual(parseProxyHostAndPort('proxy.mysterium.network:99999'), {
      host: 'proxy.mysterium.network',
      port: 443
    });
  });

  it('bypasses local, LAN, link-local, IPv6 private, Mysterium control domains, and active proxy host', () => {
    assert.equal(shouldBypassProxy('localhost'), true);
    assert.equal(shouldBypassProxy('sub.localhost'), true);
    assert.equal(shouldBypassProxy('printer.local'), true);
    assert.equal(shouldBypassProxy('127.0.0.1'), true);
    assert.equal(shouldBypassProxy('10.20.30.40'), true);
    assert.equal(shouldBypassProxy('192.168.1.1'), true);
    assert.equal(shouldBypassProxy('172.16.0.1'), true);
    assert.equal(shouldBypassProxy('172.31.255.255'), true);
    assert.equal(shouldBypassProxy('169.254.10.20'), true);
    assert.equal(shouldBypassProxy('[::1]'), true);
    assert.equal(shouldBypassProxy('fe80::1'), true);
    assert.equal(shouldBypassProxy('fd00::1234'), true);
    assert.equal(shouldBypassProxy('api.mysterium.network'), true);
    assert.equal(shouldBypassProxy('node1.myst.example', 'node1.myst.example'), true);

    // Public hosts and invalid IPv4 octets (>255) must not match RFC1918 bypasses
    assert.equal(shouldBypassProxy('172.32.0.1'), false);
    assert.equal(shouldBypassProxy('127.999.0.1'), false);
    assert.equal(shouldBypassProxy('example.com'), false);
  });

  it('parses proxy config JSON safely on valid, malformed, or empty input', () => {
    assert.deepEqual(readProxyConfigFromJson(null), {
      username: '',
      password: '',
      country: '',
      config: null
    });
    assert.deepEqual(readProxyConfigFromJson('{bad json'), {
      username: '',
      password: '',
      country: '',
      config: null
    });
    const parsed = readProxyConfigFromJson(
      JSON.stringify({ username: 'u', password: 'p', country: 'US', host: '1.2.3.4:443' })
    );
    assert.equal(parsed.username, 'u');
    assert.equal(parsed.country, 'US');
    assert.equal(parsed.config.host, '1.2.3.4:443');
  });
});

describe('myst-vpn-firefox-port polyfill & onRequest integration', () => {
  it('synchronizes proxy state across set/get/clear and prevents proxying when disconnected', async () => {
    const polyfillSource = fs.readFileSync(path.join(__dirname, '..', 'firefox-polyfill.js'), 'utf8');
    const bgSource = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

    const storageData = {
      'proxy.config': JSON.stringify({
        username: 'alice',
        password: 'secret',
        country: 'NL',
        host: '[2001:db8::5]:8443'
      }),
      __myst_firefox_proxy_state: {
        levelOfControl: 'controllable_by_this_extension',
        value: { mode: 'system' }
      }
    };
    const storageListeners = [];
    const onRequestListeners = [];
    const lastFirefoxProxySet = [];

    const context = vm.createContext({
      console: { debug: () => {}, warn: () => {}, error: () => {} },
      URL,
      Set,
      Array,
      Object,
      Number,
      String,
      Boolean,
      Promise,
      JSON,
      addEventListener: () => {},
      fetch: async () => ({ status: 200 }),
      browser: {
        runtime: { id: 'mysterium-vpn@mysterium.network' },
        action: { setIcon: () => {} },
        webRequest: {
          onAuthRequired: {
            hasListener: () => false,
            removeListener: () => {},
            addListener: () => {}
          }
        },
        storage: {
          local: {
            get: async (keys) => {
              if (keys == null) return { ...storageData };
              if (typeof keys === 'string') return { [keys]: storageData[keys] };
              const res = {};
              for (const k of keys) res[k] = storageData[k];
              return res;
            },
            set: async (items) => {
              const changes = {};
              for (const [k, v] of Object.entries(items)) {
                changes[k] = { oldValue: storageData[k], newValue: v };
                storageData[k] = v;
              }
              for (const fn of storageListeners) fn(changes, 'local');
            },
            remove: async () => {},
            clear: async () => {}
          },
          onChanged: {
            addListener: (fn) => storageListeners.push(fn)
          }
        },
        proxy: {
          onRequest: {
            addListener: (fn) => onRequestListeners.push(fn)
          },
          settings: {
            set: async (details) => {
              lastFirefoxProxySet.push(details);
            },
            get: async () => ({
              levelOfControl: 'controllable_by_this_extension',
              value: { proxyType: 'system' }
            }),
            clear: async () => {}
          }
        }
      }
    });
    context.globalThis = context;
    context.self = context;

    vm.runInContext(polyfillSource, context);
    vm.runInContext(bgSource, context);
    await new Promise((r) => setTimeout(r, 20));

    const fromVm = (obj) => JSON.parse(JSON.stringify(obj));

    // Because __myst_firefox_proxy_state in storage was controllable_by_this_extension (disconnected),
    // startup must NOT enable proxying even though stale proxy.config exists in storage
    assert.equal(onRequestListeners.length, 1);
    assert.deepEqual(fromVm(onRequestListeners[0]({ url: 'https://example.com/' })), { type: 'direct' });

    // Now connect via chrome.proxy.settings.set with fixed_servers (IPv6 singleProxy)
    await context.chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'https', host: '[2001:db8::5]:8443' },
          bypassList: ['localhost', '127.0.0.1']
        }
      }
    });
    assert.equal(lastFirefoxProxySet[0].value.http, '[2001:db8::5]:8443');

    // Now onRequest should route public traffic through the proxy and bypass local traffic
    assert.deepEqual(fromVm(onRequestListeners[0]({ url: 'https://example.com/' })), {
      type: 'https',
      host: '2001:db8::5',
      port: 8443
    });
    assert.deepEqual(fromVm(onRequestListeners[0]({ url: 'http://192.168.1.50/admin' })), {
      type: 'direct'
    });

    // Disconnect via chrome.proxy.settings.clear -> onRequest returns direct
    await context.chrome.proxy.settings.clear({});
    assert.deepEqual(fromVm(onRequestListeners[0]({ url: 'https://example.com/' })), { type: 'direct' });
  });
});
