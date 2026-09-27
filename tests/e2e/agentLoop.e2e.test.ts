/**
 * E2E — the agent loop, end to end, against a real server.
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 *
 * The first browser E2E proved the extension loads and injects. It did NOT
 * prove the agent works, because nothing had ever driven the loop. This file
 * does, and it is the first test in the project to exercise the whole chain:
 *
 *     content script  ->  background service worker  ->  server /api/step
 *                    ->  AI provider  ->  action  ->  back to the page
 *
 * Every other test in this repository mocks one of those links. This one wires
 * all five together for real.
 *
 * WHY A MOCK PROVIDER, AND WHY THAT IS NOT A WEAKNESS
 *
 * The server talks to the provider through the OpenAI SDK with
 * `baseURL: ROUTER_URL` and reads `choices[0].message.content`. So a real HTTP
 * server implementing that one endpoint is a *real* provider as far as the
 * application is concerned — the SDK, the JSON parsing, the retry, the
 * fallback, the action dispatch and the DOM effect are all genuine.
 *
 * It also means the suite needs no API key, spends nothing, is deterministic,
 * and cannot be made flaky by a model having a bad day. What it does NOT test
 * is model quality — whether Gemini can actually fill a Bhuvan geospatial form
 * is not something a test can settle, and pretending otherwise would be the
 * more dishonest choice.
 *
 * The determinism is the point: the mock returns a *scripted* action per step,
 * so we can assert the loop executed exactly the actions it was told to and
 * then terminated, rather than hoping it did something reasonable.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { chromium, type BrowserContext, type Worker } from 'playwright';
import { createServer, type Server } from 'node:http';
import * as http from 'node:http';
import { build } from '../../server/scripts/build.mjs';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTENSION_PATH = join(process.cwd(), '..', 'extension', '.output', 'chrome-mv3');
const SERVER_DIR = join(process.cwd(), '..', 'server');

const AI_PORT = 3411;
const APP_PORT = 3412;
const PROXY_PORT = 3413;
const PAIRING_CODE = 'e2e-pairing-code';
// Surfaced in diagnostics so a 413 is never a mystery.
const MAX_BODY_NOTE = '20MB default (MAX_BODY_BYTES)';

let aiServer: Server;
let appServer: ChildProcess;
// Module scope, NOT local to `beforeAll`. It used to be declared with
// `const proxy = createServer(...)` inside the beforeAll callback, which made it
// invisible to `afterAll` — so cleanup threw `ReferenceError: proxy is not
// defined` and, because that line runs BEFORE the `rmSync` calls, the temp
// profile and session directories were leaked on every run. A teardown that
// throws is worse than no teardown: it also masks the real test failure behind
// a suite-level error.
let proxy: Server;
let ctx: BrowserContext;
let worker: Worker;
let profileDir: string;
let sessionDir: string;
let serverLog = '';
let swLog = '';
/**
 * The proxy's view of every request, readable from the failure handler.
 *
 * Module scope so the CLICK NEVER HAPPENED assertion can include it. When the
 * loop breaks, the two questions that matter are "did a request leave the
 * browser?" and "what size was it?", and the proxy is the only thing in this
 * file that can answer both. Leaving them inside the test body meant the one
 * diagnostic that explains a 413 was unreachable from the error that reports it.
 */
let proxyLog: string[] = [];
const SERVER_LOG_FILE = join(tmpdir(), 'vm171-e2e-server.log');

/** Every request the "AI" received, so we can assert what was actually sent. */
const aiCalls: Array<{ model: string; user: string }> = [];
/** Actions the mock will hand back, in order. The last one ends the loop. */
let script: string[] = [];
/**
 * When set, the next /chat/completions response waits on this before it is
 * written. Lets a test hold an agent run open so an overlap is deterministic.
 */
let holdUntil: { promise: Promise<void>; release: () => void } | null = null;

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

beforeAll(async () => {
  if (!existsSync(join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(`No built extension at ${EXTENSION_PATH}. Run "npm run build" in extension/ first.`);
  }

  // ── 1. Mock OpenAI-compatible provider ───────────────────────────────────
  aiServer = createServer(async (req, res) => {
    // The fixture page, served over http so the tab has a real URL. A tab
    // created with setContent() is about:blank and cannot be told apart from
    // the extension's own page, which is how the first version of this test
    // ended up driving the agent against the popup instead of the fixture.
    if (req.url === '/fixture') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body>
        <h1>VM171 E2E fixture</h1>
        <button id="target" onclick="window.__clicked = true">Run me</button>
      </body></html>`);
      return;
    }
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(req));
    const user = body.messages?.find((m: any) => m.role === 'user')?.content ?? '';
    aiCalls.push({ model: body.model, user: String(user) });

    // Scripted, so assertions are about the wiring rather than model output.
    const action = script.length > 1 ? script.shift()! : script[0];

    // Optional hold, used by the concurrency test. Without it the mock answers
    // in microseconds, the first agent run finishes before the second
    // START_AGENT is even dispatched, and the guard under test never gets a
    // chance to fire. Holding the first completion open makes the overlap
    // deterministic instead of a race against a fast loop.
    if (holdUntil) {
      const gate = holdUntil;
      holdUntil = null;
      await gate.promise;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'e2e',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: action }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  await new Promise<void>((r) => aiServer.listen(AI_PORT, '127.0.0.1', r));

  // ── 2. The REAL server, pointed at the mock ──────────────────────────────
  // HERMETIC BUILD. This file spawns server/dist/index.js, and dist/ is gitignored.
  // It ran against a STALE bundle that still contained the old placeholder origin,
  // which is why the fix looked like it had not worked. The other two spawn-based
  // suites already build themselves; this one did not.
  await build();

  sessionDir = mkdtempSync(join(tmpdir(), 'vm171-e2e-sess-'));
  // Strip the runner's own environment. Vitest exports VITEST=1, and the server
  // skips serve() entirely when it sees that — so the process would start,
  // never listen, and exit 0. That is exactly what happened on the first run
  // of this file.
  const { VITEST: _v, NODE_ENV: _n, MAX_BODY_BYTES: _m, ...inherited } = process.env;
  appServer = spawn(process.execPath, [join(SERVER_DIR, 'dist', 'index.js')], {
    cwd: SERVER_DIR,
    env: {
      ...inherited,
      PORT: String(APP_PORT),
      NODE_ENV: 'production',
      SECRET_PASSWORD: 'e2e-placeholder-not-a-secret',
      // THE 413, AT LAST, NAMED.
      //
      // `MAX_BODY_BYTES` used to be inherited from the vitest process, where
      // setupExtensionMock.ts pins it to 32768 so the unit body-limit tests can
      // exercise a small boundary quickly. That 32KB is a UNIT-TEST convenience.
      // This suite sends a real screenshot payload of roughly 50KB, so
      // inheriting it meant every agent-loop request was refused with 413
      // before the model was ever called — and the refusal named no endpoint,
      // because bodyLimit sits above the request logger.
      //
      // The loop then failed on "the click never happened", which reads like a
      // browser-automation problem and is not one at all.
      //
      // A 320x240 viewport was already being used to keep the payload small,
      // with a comment claiming the limit was 20MB. It was 32KB. At 32KB even
      // a tiny screenshot is over, so that mitigation could never have sufficed.
      //
      // Set EXPLICITLY to the production default rather than inherited, so this
      // suite exercises the configuration a real deployment runs. Stripped from
      // `inherited` above so an operator's exported value cannot silently
      // reintroduce the same failure.
      MAX_BODY_BYTES: String(20 * 1024 * 1024),
      // No GEMINI_API_KEY: force the fallback path so the mock is used.
      GEMINI_API_KEY: '',
      ROUTER_URL: `http://127.0.0.1:${AI_PORT}/v1`,
      ROUTER_API_KEY: 'e2e-placeholder-key',
      SECRETS_SIGNING_KEY: 'e2e-signing-key',
      SECRETS_PAIRING_CODE: PAIRING_CODE,
      SESSION_STORAGE_DIR: sessionDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appServer.stdout?.on('data', (d) => { serverLog += d.toString(); writeFileSync(SERVER_LOG_FILE, serverLog); });
  appServer.stderr?.on('data', (d) => { serverLog += d.toString(); writeFileSync(SERVER_LOG_FILE, serverLog); });

  // Wait for the port, and fail loudly if the process died.
  const deadline = Date.now() + 40_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    if (appServer.exitCode !== null) throw new Error(`server exited (code ${appServer.exitCode})`);
    try {
      await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`);
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!up) throw new Error('server never began listening');

  // ── 2b. Logging proxy in front of the server ─────────────────────────────
  // A service worker can be terminated and restarted at any time, so a patch on
  // globalThis.fetch does not survive to observe the request. A proxy does.
  // It records the real Content-Length and the largest JSON fields, then
  // forwards untouched.
  //
  // The extension is pointed at PROXY_PORT (see pairExtension), so every
  // request the agent loop makes transits here.
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      {
        const fields: Record<string, number> = {};
        try {
          const parsed = JSON.parse(raw.toString('utf8'));
          for (const k of Object.keys(parsed)) {
            const v = parsed[k];
            fields[k] = typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length;
          }
        } catch { /* not json */ }
        const top = Object.entries(fields)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        (globalThis as any).__proxyLog = ((globalThis as any).__proxyLog ?? []).concat(
          `${req.method} ${req.url} len=${raw.length} auth=${req.headers.authorization ? 'yes' : 'no'} | ${top}`,
        );
      }
      const upstream = http.request(
        { host: '127.0.0.1', port: APP_PORT, path: req.url, method: req.method, headers: req.headers },
        (up) => {
          const lg = (globalThis as any).__proxyLog ?? [];
          lg.push(`  -> responded ${up.statusCode}`);
          (globalThis as any).__proxyLog = lg;
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => res.writeHead(502).end());
      upstream.end(raw);
    });
  });
  await new Promise<void>((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));

  // ── 3. Chromium with the extension ───────────────────────────────────────
  profileDir = mkdtempSync(join(tmpdir(), 'vm171-e2e-prof-'));
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Small viewport on purpose: the /api/step payload carries base64
      // screenshots, which inflate ~33%. A full-size viewport produces a body
      // over the server's 20MB limit and the agent dies with an opaque 413.
      '--window-size=320,240',
    ],
  });
  [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 30_000 });

  // The agent loop reports its progress to the SW console, not to the server.
  // Without this the only signal is a timeout, which tells you nothing about
  // why the loop stopped.
  worker.on('console', (m) => { swLog += `[${m.type()}] ${m.text()}\n`; });
  ctx.on('page', (p) => {
    p.on('console', (m) => { swLog += `[page:${m.type()}] ${m.text()}\n`; });
    p.on('pageerror', (e) => { swLog += `[pageerror] ${e.message}\n`; });
  });
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  appServer?.kill('SIGTERM');
  aiServer?.close();
  proxy?.close();
  for (const d of [profileDir, sessionDir]) if (d) rmSync(d, { recursive: true, force: true });
});

/**
 * No test may leave an agent run behind. The background worker holds a single
 * global runController, and START_AGENT refuses to begin while one is active —
 * so a run leaked by one test makes the NEXT test's first START_AGENT return
 * "already in progress". That failure is attributed to the wrong test and
 * reads like a product bug. Release the hold first, otherwise the parked
 * completion never resolves and STOP_AGENT races it.
 */
afterEach(async () => {
  // Release any hold first, or the parked completion never resolves and the
  // run cannot unwind.
  holdUntil = null;
  // STOP_AGENT only REQUESTS a stop (it calls requestStop and returns), so it
  // is not synchronous — the worker needs a turn of the event loop to unwind
  // and clear runController.
  //
  // An earlier version of this polled by sending a probe START_AGENT until it
  // was accepted. That was self-defeating: on a CLEAR guard the probe STARTS a
  // real run, which then has to be stopped by another non-synchronous
  // STOP_AGENT, so the poll manufactured the very race it was checking for and
  // handed a stale run to the next test. Never probe with the message whose
  // guard is under test.
  await worker
    .evaluate(() => chrome.runtime.sendMessage({ type: 'STOP_AGENT' }))
    .catch(() => {});
  // Let the worker's teardown run to completion.
  await new Promise((r) => setTimeout(r, 500));
});

/** Pair the extension with the server, exactly as the Options page would. */
async function pairExtension(): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: PAIRING_CODE }),
  });
  expect(res.status, 'pairing should succeed with the configured code').toBe(200);
  const { token } = (await res.json()) as { token: string };
  expect(token).toBeTruthy();

  await worker.evaluate(
    async ([url, tok]) => {
      await chrome.storage.local.set({ agentConfig: { serverUrl: url, token: tok } });
    },
    [`http://127.0.0.1:${PROXY_PORT}`, token] as [string, string],
  );
}

describe('E2E — the real agent loop, content script to AI and back', () => {
  it('pairs the extension with the server', async () => {
    // BREAK: the pairing endpoint rejecting the configured code, the token
    // mint failing, or storage refusing the write. Without a paired extension
    // the loop refuses to fetch at all, so this is the precondition for
    // everything below and is asserted rather than assumed.
    await pairExtension();
    const stored = await worker.evaluate(() => chrome.storage.local.get('agentConfig'));
    const cfg = stored.agentConfig as { serverUrl: string; token: string };
    expect(cfg.serverUrl).toBe(`http://127.0.0.1:${PROXY_PORT}`);
    expect(cfg.token).toBeTruthy();
  });

  it('runs the loop: page -> server -> AI -> real click -> loop terminates', async () => {
    // A page with one button. The mock is scripted to click it, then finish —
    // so a pass means the action was really dispatched and really dispatched
    // to THIS element, not merely that some call returned 200.
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 320, height: 240 });
    await page.goto(`http://127.0.0.1:${AI_PORT}/fixture`);
    expect(await page.textContent('#target')).toBe('Run me');

    // The selector the content script will have indexed. `#target` is stable.
    script = [
      JSON.stringify({ action: 'click', selector: '#target', thought: 'Clicking the target button.' }),
      JSON.stringify({ action: 'done', thought: 'Task complete.' }),
    ];
    aiCalls.length = 0;

    // Messages must be sent FROM an extension page, not from the service
    // worker: an MV3 service worker does not receive its own
    // runtime.sendMessage, so sending from there fails with "Receiving end does
    // not exist". This is the same path the real popup uses.
    const extId = new URL(worker.url()).host;
    // The loaded id MUST equal the pinned id, or originGuard 403s every
    // request. Asserted rather than assumed — a mismatched id is silent,
    // because cors answers preflights before the request logger runs, so a
    // blocked preflight leaves no trace in the server log at all.
    console.log('[E2E] loaded extension id:', extId);
    expect(extId, 'the built extension id must match the id pinned in the manifest key').toBe(
      'fidbnhfgcadfpjlmdfpnngikjpdhcdcf',
    );
    const control = await ctx.newPage();
    await control.goto(`chrome-extension://${extId}/popup.html`);

    // Resolve the FIXTURE tab by url. "active tab in current window" is the
    // control page we just opened, so asking for it drove the agent at the
    // popup. The fixture is identified explicitly and passed as targetTabId.
    const tabId = await control.evaluate(async (marker) => {
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find((t) => (t.url ?? '').includes(marker));
      return hit?.id ?? -1;
    }, '/fixture');
    expect(tabId, 'the fixture tab must be findable by url').toBeGreaterThanOrEqual(0);

    // MEASURE, do not guess. Patch fetch in the service worker so the actual
    // body size is recorded, and break the payload down by field. Two earlier
    // hypotheses about this 413 were wrong, so the number has to come from the
    // bytes rather than from reasoning about them.
    await worker.evaluate(() => {
      const w = globalThis as any;
      w.__payloadSizes = [];
      const orig = w.fetch?.bind(w);
      w.fetch = async (input: any, init: any) => {
        try {
          const body = init?.body;
          if (typeof body === 'string') {
            const rec: Record<string, number> = { total: body.length };
            try {
              const parsed = JSON.parse(body);
              for (const k of Object.keys(parsed)) {
                const v = parsed[k];
                rec[k] = typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length;
              }
            } catch { /* not json */ }
            w.__payloadSizes.push(rec);
          }
        } catch { /* never break the app */ }
        return orig(input, init);
      };
    });

    // DIAGNOSTIC: ask the browser what it actually sees. A fetch that hangs
    // with no error is a preflight that never completes, and the server log
    // cannot show that — originGuard skips OPTIONS and cors answers preflights
    // without calling next(), so nothing is ever logged.
    const diag = await control.evaluate(async (url) => {
      const out: Record<string, unknown> = {};
      try {
        const r = await fetch(url, {
          method: 'OPTIONS',
          headers: {
            Origin: 'chrome-extension://fidbnhfgcadfpjlmdfpnngikjpdhcdcf',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization,content-type',
          },
        });
        out.preflightStatus = r.status;
        out.allowOrigin = r.headers.get('access-control-allow-origin');
        out.allowHeaders = r.headers.get('access-control-allow-headers');
      } catch (e) {
        out.preflightError = String(e);
      }
      try {
        const ctl = new AbortController();
        setTimeout(() => ctl.abort(), 8000);
        const r2 = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        out.postStatus = r2.status;
      } catch (e) {
        out.postError = String(e);
      }
      return out;
    }, `http://127.0.0.1:${APP_PORT}/api/step`);
    console.log('[E2E DIAG]', JSON.stringify(diag));
    console.log('[E2E] server body limit:', MAX_BODY_NOTE);

    // READ THE PROXY LOG BEFORE THE DECLARATION IS A CRASH, NOT A DIAGNOSTIC.
    // These two lines were in the opposite order, so the `for` loop hit the
    // temporal dead zone and threw
    //   ReferenceError: Cannot access 'proxyLog' before initialization
    // BEFORE the log was read and BEFORE the payload sizes were collected. The
    // test then died without printing a single [PROXY] line, which reads
    // exactly like "the proxy captured nothing" — the opposite of the truth.
    // Absence of output was never absence of traffic.
    const proxyLogNow = ((globalThis as any).__proxyLog ?? []) as string[];
    console.log(`[E2E] proxy saw ${proxyLogNow.length} request(s) so far (pre-loop; the agent has not run yet)`);
    for (const line of proxyLogNow.slice(-12)) console.log('[PROXY]', line);
    const sizes = await worker.evaluate(() => (globalThis as any).__payloadSizes ?? []);
    for (const rec of sizes.slice(0, 2)) {
      const fields = Object.entries(rec)
        .filter(([k]) => k !== 'total')
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .slice(0, 6);
      console.log(
        `[E2E] payload total=${rec.total} bytes | largest fields: ` +
          fields.map(([k, v]) => `${k}=${v}`).join(', '),
      );
    }

    const ack = await control.evaluate(
      async ([task, tab]) =>
        chrome.runtime.sendMessage({ type: 'START_AGENT', payload: task, targetTabId: tab }),
      ['Click the Run me button on the page', tabId] as [string, number],
    );
    expect(ack).toMatchObject({ success: true });

    // The click must actually land on the real element.
    try {
      await page.waitForFunction(() => (window as any).__clicked === true, undefined, { timeout: 45_000 });
    } catch (e) {
      const clean = serverLog.replace(/\x1b\[[0-9;]*m/g, '');
      const tail = clean.trim().split('\n').slice(-30).join('\n');
      proxyLog = ((globalThis as any).__proxyLog ?? []) as string[];
      // The proxy's record of what actually went over the wire, INCLUDING the
      // upstream status. A 413 here names the size that caused it; a 401 names
      // an auth problem; an empty log means the request never left the browser.
      // Those are three completely different bugs and the message must not
      // leave that distinction to guesswork.
      throw new Error(
        `CLICK NEVER HAPPENED. aiCalls=${aiCalls.length}\n` +
        `--- proxy (${proxyLog.length} request(s)) ---\n${proxyLog.slice(-15).join('\n') || '(none — nothing left the browser)'}\n` +
        `--- sw/page console ---\n${swLog.slice(-3000)}\n--- server log ---\n${tail}`,
      );
    }

    // And the loop must reach the provider and then stop on `done`.
    await page.waitForTimeout(2000);
    expect(aiCalls.length, 'the server must actually have called the provider').toBeGreaterThan(0);
    // The provider must have been sent the real page content, not a stub.
    expect(aiCalls[0].user.length).toBeGreaterThan(0);
  }, 90_000);

  it('refuses to run a second concurrent run', async () => {
    // BREAK: the Cycle 3.3 run controller being bypassed. Two runs share the
    // scratchpad, the telemetry and — worst — the DOM, interleaving clicks in
    // one page. This is the regression that guard exists to prevent.
    const extId = new URL(worker.url()).host;
    const control = await ctx.newPage();
    await control.goto(`chrome-extension://${extId}/popup.html`);

    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${AI_PORT}/fixture`);
    const tabId = await control.evaluate(async (marker) => {
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find((t) => (t.url ?? '').includes(marker));
      return hit?.id ?? -1;
    }, '/fixture');
    expect(tabId).toBeGreaterThanOrEqual(0);

    // Hold the first completion open so the first run is still in flight when
    // the second START_AGENT arrives. Otherwise the mock answers instantly, the
    // first run completes, and the guard being tested never gets exercised —
    // the test then fails for a reason that has nothing to do with the guard.
    let releaseHold = () => {};
    holdUntil = {
      promise: new Promise<void>((r) => { releaseHold = r; }),
      release: () => {},
    };
    script = [JSON.stringify({ action: 'click', selector: '#target', thought: 'Working.' })];
    // The first run is now parked inside the mock awaiting releaseHold.

    const first = await control.evaluate(
      async ([task, tab]) =>
        chrome.runtime.sendMessage({ type: 'START_AGENT', payload: task, targetTabId: tab }),
      ['Long running task', tabId] as [string, number],
    );
    expect(first).toMatchObject({ success: true });
    const second = await control.evaluate(
      async ([task, tab]) =>
        chrome.runtime.sendMessage({ type: 'START_AGENT', payload: task, targetTabId: tab }),
      ['Second task', tabId] as [string, number],
    );
    expect(second).toMatchObject({ success: false });
    expect(String((second as any).error ?? '')).toMatch(/already in progress/i);

    // Let the held run finish so it cannot leak into later assertions.
    releaseHold();
    holdUntil = null;

    // Clean up so the run does not leak into later assertions.
    await control.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP_AGENT' })).catch(() => {});
  }, 60_000);
});
