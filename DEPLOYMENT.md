# Zero-Trust AI Web Agent — Deployment & Operations Guide

This guide documents the end-to-end deployment lifecycle for the Zero-Trust AI Web Agent, covering the local server runtime, the browser extension, security boundaries, and Chrome Web Store publishing.

---

## 1. Prerequisites

Before building or deploying any part of the system, ensure the host machine satisfies the following verified requirements:

*   **Node.js**: `v22.x` or higher (verified on Node `v22.23.3`; runtime bundle targets `node20`).
*   **npm**: `v10.x` or higher (verified on npm `10.9.9`).
*   **Git**: Required for source control, versioning, and CI hygiene.
*   **Google Chrome / Chromium**: Version 109.0+ (Manifest V3 support with Service Workers, Side Panel API, and Canvas/Offscreen capabilities).
*   **Build Tools**: Standard POSIX shell utilities (`zip`, `mkdir`, `rm`).

---

## 2. Repository Structure & Build Scripts

The repository consists of three decoupled workspaces (server, extension, and tests), each with dedicated scripts in its respective `package.json`.

```
.
├── server/               # Local backend runtime (Hono, OpenAI/Gemini SDKs, local storage)
│   ├── package.json
│   ├── src/index.ts      # Main server entrypoint
│   └── scripts/build.mjs # Production bundler (esbuild)
├── extension/            # Chrome Extension MV3 (WXT framework, React, on-device ML)
│   ├── package.json
│   ├── wxt.config.ts     # WXT configuration & Manifest definition
│   └── scripts/          # Model download & asset sync hooks
├── tests/                # Test harness (unit, integration, security, e2e)
│   └── package.json
└── DEPLOYMENT.md         # Deployment & Operations specification
```

### Verified Workspace Commands

#### Server (`server/`)
*   **Typecheck**:
    ```bash
    npm --prefix server run typecheck
    # Executes: tsc --noEmit -p tsconfig.json
    ```
*   **Production Build**:
    ```bash
    npm --prefix server run build
    # Executes: node scripts/build.mjs -> bundles server into server/dist/index.js
    ```
*   **Production Start**:
    ```bash
    npm --prefix server run start
    # Executes prestart (npm run build) then: node dist/index.js
    ```
*   **Development Watch Mode**:
    ```bash
    npm --prefix server run dev
    # Executes: tsx watch src/index.ts
    ```

#### Extension (`extension/`)
*   **Typecheck**:
    ```bash
    npm --prefix extension run typecheck
    # Executes: tsc --noEmit -p tsconfig.json
    ```
*   **Fetch Pretrained ML Assets**:
    ```bash
    npm --prefix extension run fetch-models
    # Downloads on-device ONNX & MediaPipe models to extension/public/
    ```
*   **Production Build**:
    ```bash
    npm --prefix extension run build
    # Executes: wxt build && node scripts/copy-assets.mjs
    # Emits output to: extension/.output/chrome-mv3/
    ```
*   **Development Server**:
    ```bash
    npm --prefix extension run dev
    # Starts WXT dev server on http://localhost:3300
    ```
*   **Unit Tests**:
    ```bash
    npm --prefix extension test
    # Executes: vitest run
    ```

#### Integration & Security Test Suite (`tests/`)
*   **Full Test Suite**:
    ```bash
    npm --prefix tests test
    # Executes: vitest run (across unit, integration, and security suites)
    ```
*   **Targeted Suites**:
    ```bash
    npm --prefix tests run test:unit
    npm --prefix tests run test:integration
    npm --prefix tests run test:security
    ```

---

## 3. Server Configuration (`server/.env`)

The server configuration resides in `server/.env`. Copy `server/.env.example` to `server/.env`. **Never commit a filled `.env` file to version control.**

All variables documented below are validated and loaded at boot.

### Mandatory Environment Variables

| Variable | Description | Failure Behavior if Missing / Invalid |
| :--- | :--- | :--- |
| `SECRET_PASSWORD` | Redactor canary secret used to verify that no operational secrets leak to logs. | Server refuses to boot with `Missing required environment variable: SECRET_PASSWORD` (`process.exit(1)`), unless running under `NODE_ENV=test` or `VITEST=true`. |
| Upstream AI Provider | One of the following configurations must be present: | Server refuses to boot with `No AI provider configured! Provide either GEMINI_API_KEY or (ROUTER_URL and ROUTER_API_KEY)` (`process.exit(1)`). |
| ↳ `GEMINI_API_KEY` | Direct Google Gemini API Key (Priority 1). | Required if not using 9router fallback. |
| ↳ `ROUTER_URL` + `ROUTER_API_KEY` | Relay/fallback upstream endpoint (Priority 2). | Both required if `GEMINI_API_KEY` is omitted. |

### Optional Environment Variables (With Defaults)

| Variable | Default Value | Parsing & Validation Behavior |
| :--- | :--- | :--- |
| `PORT` | `3000` | Parsed as positive integer in range `1`–`65535`. Malformed value logs a warning and falls back to `3000`. |
| `HOST` | `127.0.0.1` | **Enforced Loopback Only**. Allowed: `127.0.0.1`, `localhost`, `::1`, `[::1]`. Non-loopback addresses are refused with a logged warning, binding `127.0.0.1` instead. |
| `SECRETS_SIGNING_KEY` | Generated at boot | HS256 JWT signing key. Set only for testing or multi-instance key pinning. |
| `SECRETS_PAIRING_CODE` | Generated at boot | One-time code exchanged by the extension during initial pairing. |
| `ALLOWED_ORIGINS` | Extension ID allowlist | Comma-separated exact origins permitted to call the API. Defaults to `chrome-extension://fidbnhfgcadfpjlmdfpnngikjpdhcdcf`, `http://localhost:3300`, `http://localhost:3000`. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model name for direct upstream calls. |
| `MODEL_NAME` | `ag/gemini-3.7-flash-high` | Model identifier used when routing via 9router. |
| `REJECT_UNREDACTED` | `false` | When `true`, payloads with unverified client-side redaction return `400 Bad Request`. When `false`, accepted and tallied as degraded. |
| `TELEMETRY_VERBOSE` | `false` | When `false`, `/api/system-telemetry` hides hardware/OS fingerprints. Set `true` only for local operator debugging. |
| `LOG_FORMAT` | `pretty` | `pretty` (colored ANSI output) or `json` (single-line JSON objects with redaction). |
| `MAX_BODY_BYTES` | `20971520` (20 MB) | Enforced by streaming body limit middleware before buffering. Malformed values fall back to default with a warning. |
| `RATE_LIMIT_MAX_REQUESTS` | `40` | Sliding window rate limit cap per client IP. Malformed values fall back to default with a warning. |
| `RATE_LIMIT_WINDOW_MS` | `60000` (1 min) | Sliding window duration in milliseconds. Malformed values fall back to default with a warning. |
| `MAX_STEPS` | `35` | Maximum execution steps allowed per session before server policy halts the agent loop. |
| `SESSION_STORAGE_DIR` | `<repo>/storage` | Path for persisted session artifacts (`sessions/<id>/`). |
| `SESSION_RETENTION_DAYS` | `7` | Retention threshold in days used by `pruneSessions()`. |
| `MAX_SESSIONS` | `100` | Maximum session directories retained on disk before oldest are evicted. |
| `WIRE_TRACE` | _(unset)_ | Set to `1` or `true` to log low-level request sizes and paths to stderr before middleware. |
| `NODE_ENV` | `production` | Runtime mode. Set to `test` to suppress exit-on-error behavior in automated test harnesses. |

---

## 4. Pairing & Authentication Flow

The legacy shared password authentication model has been replaced with cryptographically signed, short-lived bearer tokens (Cycle 2.4):

```
┌─────────────────┐                                ┌───────────────────┐
│ Operator / Host │                                │ Browser Extension │
└────────┬────────┘                                └─────────┬─────────┘
         │                                                   │
         │  1. Server Boot: generates random pairing code     │
         │     Prints code to stdout console banner          │
         │                                                   │
         │  2. Operator enters pairing code in Extension UI  │
         │──────────────────────────────────────────────────>│
         │                                                   │
         │  3. POST /api/auth/pair { "code": "..." }         │
         │<──────────────────────────────────────────────────│
         │                                                   │
         │  4. Validates code, issues HS256 Bearer JWT       │
         │     Token TTL: 15 minutes (900,000 ms)            │
         │──────────────────────────────────────────────────>│
         │                                                   │
         │  5. Saves token in chrome.storage.local           │
         │     Subsequent requests send:                     │
         │     Authorization: Bearer <jwt>                   │
         │<──────────────────────────────────────────────────│
```

1.  **Boot Banner**: On server startup, `index.ts` logs the one-time pairing code:
    ```
    ═══════════════════════════════════════════════════════════
      🚀  Zero-Trust AI Agent Server — ONLINE
    ═══════════════════════════════════════════════════════════
      Bind:              127.0.0.1:3000  (loopback only)
      CORS:              allowlist (3 origin(s)); disallowed Origin is refused with 403
      Upstream Provider: Google Gemini API (Priority 1)
      Auth:              Authorization: Bearer <jwt>
      Rate limit:        40 req/min per IP
      Payload limit:     20MB
      Session Vault:     storage/sessions/<sessionId>/

      Pairing code:      38148b5ffb7ff9c8
                          one-time; needed once, to pair the extension
    ═══════════════════════════════════════════════════════════
    ```
2.  **Token Exchange**: The operator enters the pairing code into the extension options UI. The extension sends a `POST /api/auth/pair` request with payload `{"code": "<pairing-code>"}`.
3.  **Storage**: Upon successful verification, the extension stores `{ serverUrl, token }` under the `agentConfig` key in `chrome.storage.local`.
4.  **Subsequent Requests**: All requests to protected endpoints (`/api/step`, `/api/sessions`, `/api/system-telemetry`) pass `Authorization: Bearer <token>`.

---

## 5. Network Constraints & The Loopback Barrier

### The Hard Loopback Constraint
In `extension/src/utils/config.ts`, `isAllowedServerUrl()` enforces that the server URL must strictly belong to the loopback set:
```typescript
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
```

Any attempt by the operator to configure a remote server URL (e.g. `https://agent.example.com` or `http://192.168.1.50:3000`) is **refused at write time**. The extension options UI will reject the input, and background workers will refuse to dispatch HTTP requests.

### Rationale
The Zero-Trust AI Agent architecture assumes the server process runs locally on the operator's machine. The extension captures web page screenshots, forms, and DOM trees. Sending un-redacted or partially-redacted visual data across an untrusted network boundary presents an immediate exfiltration risk.

### Options for Remote Hosting (and Trade-offs)

If you must run the server on a remote machine:

#### Option A: Local SSH Tunnel (Recommended / Zero Code Changes)
Forward loopback traffic from the client machine to the remote host over an encrypted SSH connection:
```bash
ssh -N -L 3000:127.0.0.1:3000 user@remote-gpu-host
```
*   **Result**: The extension still connects to `http://127.0.0.1:3000`. The loopback constraint in `extension/src/utils/config.ts` remains intact, and network transit is encrypted.

#### Option B: Code Modification (Security Warning)
If you deliberately alter `LOOPBACK_HOSTS` in `extension/src/utils/config.ts` to permit remote domain names:
*   You **MUST** set up TLS termination (HTTPS with valid certificates).
*   You **MUST** update `ALLOWED_ORIGINS` on the server to match your extension ID.
*   You introduce external exposure risks: network eavesdropping, DNS hijacking, and exposure of internal government portal screenshots to transit networks.

---

## 6. Server Hosting & Infrastructure Setup

### Platform Requirements
*   **Operating System**: Linux (Ubuntu 22.04 LTS / Debian 12 / RHEL 9 recommended).
*   **Memory**: Minimum 1 GB RAM (2 GB recommended for high step concurrency).
*   **Disk Storage**: Mount a persistent volume at `SESSION_STORAGE_DIR` (default `./storage/sessions`). Screenshots and JSON metadata are written per step (~10 MB per 35-step task).

### PaaS Incompatibility Notice
> [!CAUTION]
> Standard cloud PaaS platforms (e.g., Heroku, AWS App Runner, Render, Railway, Fly.io, or AWS ECS behind an Application Load Balancer) that route incoming HTTP ingress through non-loopback network interfaces (`eth0`, `0.0.0.0`) **WILL NOT WORK AS-IS**.
>
> The server's `resolveBindHost()` function strictly refuses non-loopback addresses (`HOST=0.0.0.0` is overridden to `127.0.0.1`). Binding 0.0.0.0 is deliberately blocked to prevent accidental exposure of the bearer-token pairing surface to local network peers.

### Recommended Production Deployment: Systemd on Host

Create `/etc/systemd/system/zero-trust-server.service`:
```ini
[Unit]
Description=Zero-Trust AI Web Agent Server
After=network.target

[Service]
Type=simple
User=agentuser
WorkingDirectory=/opt/zero-trust-agent/server
EnvironmentFile=/opt/zero-trust-agent/server/.env
ExecStart=/usr/bin/node /opt/zero-trust-agent/server/dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zero-trust-server.service
```

Inspect boot logs to obtain the pairing code:
```bash
journalctl -u zero-trust-server.service -b --no-pager
```

---

## 7. Chrome Web Store Deployment

### Extension Key & Pinned Identity
In `extension/wxt.config.ts`, the manifest specifies a pinned public key:
```typescript
key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmdnqsNdRs2Su4Va8lqExtv3Z7sp1DDabiTjm3LvTvsfKcxzp4fbutBqfXwfhjft1y9IRSMS+skfqgV8AivWhQcWqKVZRuN/mpSaHRjpbbD+dEjfGmLVrl7kUxAXr1lZc8aEidxoh3+hLFv/wKhdyoH+Ck9s7YqnemU7WSv8rSiIsoHaHGYLs/t50yU51PdIcHGpDCDmeykEiTNXT4nn9erVL/dvyIX4UxBP9Ib9CA0MO8OUWEs8+/jOgZUmI1bBp8kJujZlSjFip+lfu9vpnRTnPmzUi8Q2rNXwxLOqDt16q6Qx0KOudLkdLOclJid5jTsK16UqXibg+8YlL9G0czQIDAQAB',
```

> [!IMPORTANT]
> **DO NOT REMOVE THE `key` FIELD.**
> Removing `key` causes Chrome to assign an arbitrary extension ID based on installation path. The server's `originGuard` specifically enforces an exact-match allowlist containing `chrome-extension://fidbnhfgcadfpjlmdfpnngikjpdhcdcf`. If the ID changes, all extension requests will be blocked with `403 Forbidden`.

### Building the Package

1.  **Compile & Postprocess Assets**:
    ```bash
    cd extension
    npm run build
    ```
    This invokes WXT compiler and executes `scripts/copy-assets.mjs` to copy MediaPipe and ONNX WASM binaries to `extension/.output/chrome-mv3`.

2.  **Verify the Build Output**:
    Confirm the output directory exists and contains all required artifacts:
    ```bash
    ls -la extension/.output/chrome-mv3
    ```
    Required structure:
    *   `manifest.json` (contains `key`, MV3 schema, version `1.0.0`)
    *   `background.js` (service worker)
    *   `content-scripts/` (DOM redaction engine)
    *   `popup.html`, `options.html`, `sidepanel.html`, `dashboard.html`
    *   `mediapipe/` and `onnx/` directories (client-side ML weights)

3.  **Package into Zip**:
    Package the contents of `extension/.output/chrome-mv3` directly (do not zip the parent folder):
    ```bash
    cd extension/.output/chrome-mv3
    zip -r ../../zero-trust-ai-agent-v1.0.0.zip ./* -x "*.map"
    cd ../../
    ```

### Chrome Web Store Submission Checklist
*   **Account**: Google Chrome Web Store Developer account registered.
*   **Privacy Practices Tab**:
    *   **Single Purpose**: "Automates browser workflows on web portals with privacy-preserving client-side PII redaction."
    *   **Permission Justifications**:
        *   `activeTab`: Inspect and interact with the user's current tab during autonomous tasks.
        *   `scripting`: Injects DOM redaction scripts and automation listeners into target pages.
        *   `storage`: Stores local pairing configuration (loopback URL and bearer token).
        *   `sidePanel`: Displays the Mission Control interface and live execution steps.
        *   `tabs`: Monitors tab completion and navigation status during agent workflows.
        *   `host_permissions: ["<all_urls>"]`: Enables DOM masking and redaction on user-specified web portals.
    *   **Data Usage**: Check "Does not collect or sell user data". All PII masking occurs on-device via WebAssembly before transmitting to local loopback backend.

---

## 8. Rollback Procedures

### Server Rollback
If an updated server release fails health checks or exhibits regressions:
1.  **Checkout Previous Revision**:
    ```bash
    git checkout <previous-stable-tag-or-commit>
    ```
2.  **Reinstall Dependencies & Rebuild**:
    ```bash
    cd server
    npm ci
    npm run build
    ```
3.  **Restart the Service**:
    ```bash
    sudo systemctl restart zero-trust-server.service
    ```
4.  **Confirm Status**:
    ```bash
    curl -s http://127.0.0.1:3000/health
    ```

### Extension Rollback
*   **Local / Developer Mode**: Open `chrome://extensions`, click **Reload** under the unpacked folder, or point to an older unpacked build directory.
*   **Chrome Web Store**: In the Chrome Developer Dashboard, upload the previous ZIP artifact with an incremented patch version number (e.g. `1.0.1` containing the rolled-back codebase) and request an expedited review.

---

## 9. Pre-Flight Checklist

Before tagging a release or deploying to operators, verify all items:

- [ ] **Typecheck Cleanliness**:
  - `npm --prefix server run typecheck` exits `0`.
  - `npm --prefix extension run typecheck` exits `0`.
- [ ] **Automated Test Suites**:
  - `npm --prefix tests test` passes all unit, integration, and security tests.
  - `npm --prefix extension test` passes all client unit tests.
- [ ] **No Credentials Committed**:
  - `git diff HEAD` shows no secrets or live API keys in `server/.env.example` or any other file.
- [ ] **Loopback Binding Verified**:
  - Booting server without `HOST` binds `127.0.0.1:3000`.
  - Setting `HOST=0.0.0.0` or `HOST=192.168.1.1` in `server/.env` is refused and logs a warning.
- [ ] **Pairing Flow Verification**:
  - Server boot banner prints a 16-character pairing code.
  - Extension successfully exchanges pairing code at `/api/auth/pair`.
  - Storage holds `{ serverUrl: "http://127.0.0.1:3000", token: "<jwt>" }`.
- [ ] **Manifest Key Invariant**:
  - `manifest.json` in `extension/.output/chrome-mv3` includes `key` mapping to `fidbnhfgcadfpjlmdfpnngikjpdhcdcf`.
- [ ] **ML Asset Integrity**:
  - `extension/.output/chrome-mv3/mediapipe/` and `onnx/` are non-empty.
