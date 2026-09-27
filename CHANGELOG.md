# Changelog

All notable changes to VM171 / Zero-Trust AI Web Agent.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

Nothing yet.

---

## [1.0.0] — 2026-09-26

First tagged release. A 30-cycle security hardening pass over the
Chrome MV3 extension + Hono server, plus the CI and release scaffolding to
keep it that way.

### Security — data safety (client)

- **Completion is an observation, not an instruction.** A success toast used to
  inject `Conclude goal with action: "done"` into the prompt, gated on a
  substring match against page text — so any page containing *"thank you for
  your submission"* could end the agent's run early. Now produces structured
  evidence with a strength, a source and a locale, and `verified: false` with
  no code path that can set it. Whether the agent may stop is decided
  server-side, where page text cannot issue instructions. English and Hindi
  ship; a failure message on the page vetoes a success one.
- PII masking extended from 12 to 24 enforced classes.
- Outbound text escaped and length-capped; untrusted content delimited and
  neutralised to inert tags.
- Image payloads validated by magic bytes; redaction policy centralised with a
  degradation tally; capture provenance split into outbound vs archival.
- Logging redacts keys, JWTs and PEM blocks; step records persist counts and
  redaction *types* rather than page content.

### Security — trust boundary (server)

- HS256 bearer-token auth replacing a shared `SECRET_PASSWORD`, issued by a
  pairing endpoint. All routes require `Authorization: Bearer`, `/health`
  included. The legacy `x-secret-password` header is refused on purpose.
- **Loopback-only bind, enforced.** `HOST` was documented but never read, so the
  server bound every interface and answered on the LAN address. A non-loopback
  value is now refused and logged.
- Origin allowlist, per-socket-IP rate limiting, 25 MB body cap, zod request
  schemas.
- Server-side PII firewall as a hard pre-egress gate
  (`400 UNSANITIZED_PAYLOAD_REJECTED`).
- Session pruning, telemetry minimisation, redactor.
- The pairing code is printed on boot. It was generated and validated but never
  shown, so on the default path the extension could not be paired at all.
- CORS now sanctions `Authorization`. It still advertised only `Content-Type`
  and the dead header, so every authenticated browser request was blocked —
  invisible to the curl-based smoke test, which does not preflight.
- **Model downloads fail closed on digest mismatch.** `fetch-models` had no
  integrity check and failed open on every error path, writing unverified WASM
  and model binaries from a public CDN into the shipped bundle. Assets are now
  pinned by sha256, an asset with no pin is refused rather than trusted, and a
  mismatch deletes the file and exits non-zero.

### Security — agent control

- Server-side action policy between the model and `executeAction`, so a
  successful prompt injection still cannot cause a dangerous action.
- Confirmation gates for destructive and irreversible actions.
- Single-active-run controller; cancellation scoped to a run id.
- TypeScript strict mode across all three projects.

### Build, CI and release

- Server bundles to a single ESM artifact; `npm start` no longer transpiles
  TypeScript at boot.
- `.github/workflows/ci.yml` with six jobs. The extension typecheck was advisory
  while 74 errors remained — a permanently red gate trains people to ignore
  red. Those errors are now **zero**, so the typecheck is a hard gate. The
  secret scan and the dependency audits remain advisory: the first because the
  history still holds live keys, the second while moderate advisories remain.
- `scripts/verify-repo-hygiene.mjs` and `scripts/verify-bundle.mjs`, both
  verified to fail on injected faults rather than merely to pass.
- PowerShell launchers brought back in line with the code. Both had rotted
  unreconciled: `s.ps1` rejected valid Gemini-only setups and force-killed any
  process on port 3000; `171s.ps1`'s Ctrl+C handler never fired and it declared
  success over a server that had already exited.
- Documentation corrected: the auth model, the cloud-deploy sections that
  loopback enforcement now contradicts, and the pitch document's claims about a
  database, billing and user accounts that were never built.

### Known issues

- `host_permissions: ['<all_urls>']` is required for a cross-site agent and is
  a standing risk; it needs Web Store review.
- All `high` and `critical` advisories are cleared. `vitest` moved 1.6.1 → 3.2.7
  (1 high + 1 critical) and the extension's five highs were closed with npm
  `overrides` for `adm-zip` and `tmp`; `wxt` stays on 0.19.x. `vitest` 5.x was
  not used: it needs vite 6/7/8, the tree resolves vite 5 via `wxt`, and forcing
  past that produces a tree that installs but does not run. Four `moderate`
  advisories remain in dev tooling only and ship in nothing.
- The E2E suite still cannot run on a host without a Chromium binary. It runs
  in CI, where the browser is installed.
- Neither PowerShell launcher has ever been executed — there is no PowerShell
  on the Linux build host and no Windows CI.
- `fetch-models` covers the three MediaPipe assets. The ONNX OCR/UI models
  vendored under `extension/public/onnx/` are not pinned.
- `noUncheckedIndexedAccess` is off in the extension. Turning it on would prove
  index access safe but cascades into unrelated errors; it wants its own change.
- `GET /api/system-telemetry` walks the session tree synchronously on every call
  and the dashboard polls it once a second.

### Documentation corrections

- The zero-egress claim was overstated in three documents. The raw frame never
  reaches an AI provider and never crosses the network, but it *is* sent to the
  local server and written to disk in cleartext for the audit trail. Corrected
  in `README.md` (with a new "Local Storage of Raw Frames" section),
  `ZERO_TRUST_AI_WEB_AGENT_SPECIFICATION.md` and `system-architecture.md`.
- `README.md` environment table and `s.ps1` now cover every variable the server
  actually reads, including the ones that were documented but unwired.

### Security history — requires operator action

Commit `8dec66fe` contains a live `GEMINI_API_KEY`, a live `ROUTER_API_KEY`, and
`storage/server_logs.jsonl` with 673 entries of un-redacted page captures
including 7 real third-party email addresses. Both are reachable from the public
repositories `jassu-Workspace/171-code` and `jassu-Workspace/VM171`.

Untracking stopped further commits. It does not remove anything from history.
**Both keys must be treated as compromised and rotated.** The email addresses
are permanently disclosed.

[Unreleased]: https://github.com/jassu-Workspace/VM171/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/jassu-Workspace/VM171/releases/tag/v1.0.0
