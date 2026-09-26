
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: [],
  dev: {
    server: {
      port: 3300,
    },
  },
  // Entrypoints (auto-discovered by WXT):
  //  - src/entrypoints/background  → MV3 service worker (telemetry engine)
  //  - src/entrypoints/content      → content script (redaction)
  //  - src/entrypoints/popup        → popup UI
  //  - src/entrypoints/dashboard    → full-tab Mission Control page, built as
  //    /dashboard.html (WXT unlisted page). Open via
  //    browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') }).
  vite: () => ({
    css: {
      postcss: './postcss.config.js',
    },
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  }),
  manifest: {
    name: 'Zero-Trust AI Web Agent',
    description: 'A zero-trust AI web agent that masks PII and executes actions locally',
    version: '1.0.0',
    // PINNED EXTENSION ID.
    //
    // Without `key`, Chrome derives the ID from the load path, so it differs on
    // every machine. The server's origin allowlist cannot list an ID it does not
    // know, so an unpacked build was rejected by originGuard with a 403 before
    // auth was ever reached — the extension could not talk to the server at all
    // in the default configuration.
    //
    // The PUBLIC key only. It is not a secret: it is shipped in the manifest and
    // is what makes the ID stable and knowable in advance. The private key is
    // NOT in this repository.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmdnqsNdRs2Su4Va8lqExtv3Z7sp1DDabiTjm3LvTvsfKcxzp4fbutBqfXwfhjft1y9IRSMS+skfqgV8AivWhQcWqKVZRuN/mpSaHRjpbbD+dEjfGmLVrl7kUxAXr1lZc8aEidxoh3+hLFv/wKhdyoH+Ck9s7YqnemU7WSv8rSiIsoHaHGYLs/t50yU51PdIcHGpDCDmeykEiTNXT4nn9erVL/dvyIX4UxBP9Ib9CA0MO8OUWEs8+/jOgZUmI1bBp8kJujZlSjFip+lfu9vpnRTnPmzUi8Q2rNXwxLOqDt16q6Qx0KOudLkdLOclJid5jTsK16UqXibg+8YlL9G0czQIDAQAB',

    permissions: ['activeTab', 'scripting', 'storage', 'sidePanel', 'tabs'],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
    browser_specific_settings: {
      gecko: {
        id: 'sih-agent@isro.in',
        strict_min_version: '109.0',
      },
    },
    action: {
      default_title: 'Zero-Trust AI Agent',
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    web_accessible_resources: [
      {
        resources: ['onnx/*'],
        matches: ['<all_urls>'],
      },
      {
        resources: ['mediapipe/*', 'mediapipe/wasm/*'],
        matches: ['<all_urls>'],
      },
      {
        resources: ['tesseract/*'],
        matches: ['<all_urls>'],
      },
    ],
  },
});
