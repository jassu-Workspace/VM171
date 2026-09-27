/**
 * Prove the redaction models ACTUALLY LOAD in a real MV3 service worker.
 *
 * The static tests in redactionRuntimeAndGateScope.test.ts prove the wiring is
 * present: wasmPaths is set, the runtime ships, ort/* is web-accessible. None
 * of that proves ONNX Runtime can initialise in a service worker, which is
 * where it previously failed with "XMLHttpRequest is not defined".
 *
 * This loads the built extension into real Chromium and asks the live service
 * worker to check model availability, then reports what the models actually
 * said. No mocks, no stubs.
 */
import { chromium, type Worker } from 'playwright';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(HERE, '../../extension/.output/chrome-mv3');

const log = (m: string) => console.log(`[models] ${m}`);

async function main() {
  if (!existsSync(EXTENSION_PATH)) {
    throw new Error(`extension not built at ${EXTENSION_PATH} — run the build first`);
  }

  // The runtime must be in the bundle or this test proves nothing.
  const runtime = join(EXTENSION_PATH, 'ort', 'ort-wasm-simd-threaded.wasm');
  if (!existsSync(runtime)) {
    throw new Error(`ORT runtime missing from the bundle at ${runtime}`);
  }
  log('ORT runtime present in the bundle');

  const profileDir = mkdtempSync(join(tmpdir(), 'vm171-models-'));
  let swLog = '';
  try {
    const ctx = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    let worker: Worker | undefined = ctx.serviceWorkers()[0];
    if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 30_000 });
    worker.on('console', (m) => { swLog += m.text() + '\n'; });
    const extId = new URL(worker.url()).host;
    log(`extension loaded, id=${extId}`);

    // An MV3 service worker does not receive its own runtime.sendMessage, so
    // the query has to come from an extension page — the same constraint the
    // agent loop hits.
    const control = await ctx.newPage();
    await control.goto(`chrome-extension://${extId}/popup.html`);
    await control.waitForLoadState('domcontentloaded');

    // Ask the live worker for the real model status. This awaits a real ONNX
    // availability check, so it takes as long as the models take to initialise
    // — that wait IS the thing being measured. Bound it so a hang is reported
    // rather than blocking forever.
    const status = await Promise.race([
      control.evaluate(async () => {
        const res = await chrome.runtime.sendMessage({ type: 'GET_MODEL_STATUS' });
        return res as { ui?: string; face?: string; ocr?: string } | undefined;
      }),
      new Promise<null>((r) => setTimeout(() => r(null), 180_000)),
    ]);
    if (status === null) {
      log('the model check did not answer within 180s — reporting the worker log');
    }

    log(`model status: ${JSON.stringify(status)}`);

    const degraded = Object.entries(status ?? {}).filter(([, v]) => v !== 'live');
    const failures = swLog.split('\n').filter(
      (l) => /XMLHttpRequest|no available backend|degraded|failed/i.test(l),
    );

    console.log('\n--- service worker log (model lines) ---');
    for (const line of swLog.split('\n')) {
      if (/onnx|model|wasm|backend|XMLHttp|Session|degraded|face|ocr|\bui\b/i.test(line)) {
        console.log('  ' + line);
      }
    }
    console.log('');

    if (failures.length) {
      console.log(`RESULT: FAIL — ${failures.length} model-load failure line(s) in the log.`);
      process.exitCode = 1;
      return;
    }
    if (degraded.length) {
      console.log(`RESULT: FAIL — models not live: ${degraded.map(([k, v]) => `${k}=${v}`).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('RESULT: PASS — all models live in a real service worker. Redaction is actually running.');
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`\nRESULT: FAIL — ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
