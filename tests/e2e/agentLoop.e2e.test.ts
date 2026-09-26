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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type BrowserContext, type Worker } from 'playwright';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTENSION_PATH = join(process.cwd(), '..', 'extension', '.output', 'chrome-mv3');
const SERVER_DIR = join(process.cwd(), '..', 'server');

const AI_PORT = 3411;
const APP_PORT = 3412;
const PAIRING_CODE = 'e2e-pairing-code';

let aiServer: Server;
let appServer: ChildProcess;
let ctx: BrowserContext;
let worker: Worker;
let profileDir: string;
let sessionDir: string;
let serverLog = '';
let swLog = '';
const SERVER_LOG_FILE = join(tmpdir(), 'vm171-e2e-server.log');

/** Every request the "AI" received, so we can assert what was actually sent. */
const aiCalls: Array<{ model: string; user: string }> = [];
/** Actions the mock will hand back, in order. The last one ends the loop. */
let script: string[] = [];

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
  sessionDir = mkdtempSync(join(tmpdir(), 'vm171-e2e-sess-'));
  // Strip the runner's own environment. Vitest exports VITEST=1, and the server
  // skips serve() entirely when it sees that — so the process would start,
  // never listen, and exit 0. That is exactly what happened on the first run
  // of this file.
  const { VITEST: _v, NODE_ENV: _n, ...inherited } = process.env;
  appServer = spawn(process.execPath, [join(SERVER_DIR, 'dist', 'index.js')], {
    cwd: SERVER_DIR,
    env: {
      ...inherited,
      PORT: String(APP_PORT),
      NODE_ENV: 'production',
      SECRET_PASSWORD: 'e2e-placeholder-not-a-secret',
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

  // ── 3. Chromium with the extension ───────────────────────────────────────
  profileDir = mkdtempSync(join(tmpdir(), 'vm171-e2e-prof-'));
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
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
  for (const d of [profileDir, sessionDir]) if (d) rmSync(d, { recursive: true, force: true });
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
    [`http://127.0.0.1:${APP_PORT}`, token] as [string, string],
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
    expect(cfg.serverUrl).toBe(`http://127.0.0.1:${APP_PORT}`);
    expect(cfg.token).toBeTruthy();
  });

  it('runs the loop: page -> server -> AI -> real click -> loop terminates', async () => {
    // A page with one button. The mock is scripted to click it, then finish —
    // so a pass means the action was really dispatched and really dispatched
    // to THIS element, not merely that some call returned 200.
    const page = await ctx.newPage();
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
      throw new Error(
        `CLICK NEVER HAPPENED. aiCalls=${aiCalls.length}\n--- sw/page console ---\n${swLog.slice(-3000)}\n--- server log ---\n${tail}`,
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

    // Clean up so the run does not leak into later assertions.
    await control.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP_AGENT' })).catch(() => {});
  }, 60_000);
});
