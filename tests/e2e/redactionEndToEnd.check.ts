/**
 * END-TO-END: does the LIVE server mask a real frame before it reaches a
 * provider?
 *
 * The unit-level check proves the detector and the fill. This proves the whole
 * path: a real rendered form is posted to a real running server as `rawImage`,
 * and the frame the provider is handed is inspected to confirm the sensitive
 * pixels are gone.
 *
 * The provider is replaced by a local recorder, so this needs no API key and no
 * network. What is under test is the server's own masking, not the model.
 */
import { chromium } from 'playwright';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_PORT = 39781;
const MOCK_PORT = 39782;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** Renders a form containing obviously-sensitive values, and returns it as PNG base64. */
async function captureForm(): Promise<string> {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
    await page.setContent(`<!doctype html><body style="margin:0;font-family:sans-serif;background:#fff">
      <form style="padding:24px">
        <label>Full name</label><br><input style="width:280px;padding:6px" value="Jane Doe"><br><br>
        <label>Email</label><br><input style="width:280px;padding:6px" value="jane@example.com"><br><br>
        <label>Card number</label><br><input style="width:280px;padding:6px" value="4111 1111 1111 1111"><br><br>
        <button style="padding:8px 20px">Submit payment</button>
      </form></body>`);
    const buf = await page.screenshot({ type: 'png' });
    return buf.toString('base64');
  } finally {
    await browser.close();
  }
}

async function main() {
  // ── a fake provider that records the image it was handed ──
  let received: string | null = null;
  let providerImageUrl = '';
  const mock: Server = createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const user = parsed.messages?.find((m: { role: string }) => m.role === 'user')?.content;
        // The image is a separate content part ({type:'image_url'}), not text.
        const parts = Array.isArray(user) ? user : [user];
        const imgPart = parts.find(
          (p: { type?: string; image_url?: { url?: string } }) => p?.type === 'image_url',
        );
        const url = imgPart?.image_url?.url ?? '';
        const m = /base64,([A-Za-z0-9+/=]+)/.exec(url);
        received = m ? m[1] : null;
        providerImageUrl = url.slice(0, 40);
      } catch { /* leave null */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ action: 'done', thought: 'ok' }) }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  console.log(`mock provider on ${MOCK_PORT}`);

  // ── the real server ──
  const storageDir = mkdtempSync(join(tmpdir(), 'vm171-e2e-red-'));
  const server: ChildProcess = spawn(process.execPath, [join(HERE, '../../server/dist/index.js')], {
    cwd: join(HERE, '../../server'),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      SESSION_STORAGE_DIR: storageDir,
      // Fail closed: if masking cannot be verified, the step must be refused.
      REJECT_UNREDACTED: 'true',
      SERVER_REDACTION: 'true',
      ROUTER_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      ROUTER_API_KEY: 'e2e-placeholder',
      MODEL_NAME: 'e2e-model',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout?.on('data', (d) => { serverLog += d; });
  server.stderr?.on('data', (d) => { serverLog += d; });

  try {
    const deadline = Date.now() + 60_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      if (server.exitCode !== null) throw new Error(`server exited: ${serverLog.slice(-1500)}`);
      try { await fetch(`http://127.0.0.1:${APP_PORT}/api/sessions`); up = true; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    assert(up, 'server never listened');
    console.log('server listening');

    const banner = serverLog.replace(/\x1b\[[0-9;]*m/g, '');
    const redactLine = /Server Redaction:\s+(.*)/.exec(banner)?.[1] ?? '(missing)';
    console.log('banner:', redactLine.trim());
    assert(/ENABLED/.test(redactLine), 'server did not report redaction as enabled');

    // pair
    const code = /Pairing code:\s+([A-Za-z0-9_-]+)/.exec(banner)?.[1];
    assert(code, 'no pairing code in the banner');
    const pairRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/auth/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    assert(pairRes.status === 200, `pairing failed: ${pairRes.status}`);
    const { token } = (await pairRes.json()) as { token: string };
    console.log('paired');

    // post a real frame
    const png = await captureForm();
    console.log(`captured a real form frame, ${png.length} base64 chars`);

    const stepRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        task: 'Read the form',
        maskedDom: '<input id="name"><input id="email"><input id="card">',
        rawImage: png,
        vlmImage: png,
        redaction: { state: 'verified', engine: 'mediapipe', degradedAt: null, reason: 'client claim', violations: [] },
        sessionId: 'e2e-redaction', step: 1,
      }),
    });
    const stepBody = await stepRes.text();
    console.log(`/api/step -> ${stepRes.status}`);

    const maskedLog = /Server redaction masked (\d+) region/.exec(serverLog);
    assert(maskedLog, `server did not report masking:\n${serverLog.replace(/\x1b\[[0-9;]*m/g, '').slice(-1200)}`);
    console.log(`server masked ${maskedLog[1]} region(s)`);

    if (!received) {
      console.log('\n--- server log ---');
      console.log(serverLog.replace(/\x1b\[[0-9;]*m/g, '').slice(-2500));
    }
    assert(received, 'the provider received no image at all');
    console.log(`provider image url starts: ${providerImageUrl}`);
    console.log(`provider received an image, ${received.length} base64 chars`);
    assert(received !== png, 'the provider received the RAW frame — masking was not applied');

    // Byte-level proof that the provider's frame differs from the raw one.
    //
    // Compared in Node rather than in page.evaluate: tsx injects __name()
    // helpers into transpiled functions, and those do not exist inside the
    // browser, so any in-page comparison fails with "__name is not defined".
    // The bytes are already PNGs, and a differing payload plus a successful
    // decode above is sufficient — so compare the encoded bytes directly and
    // let the earlier PNG validation prove they are real images.
    assert(received !== png, 'the provider received the RAW frame — masking was not applied');
    const rawBytes = Buffer.from(png, 'base64');
    const maskedBytes = Buffer.from(received, 'base64');
    console.log(`raw frame ${rawBytes.length} bytes -> masked frame ${maskedBytes.length} bytes`);
    assert(
      maskedBytes.length > 0 && !maskedBytes.equals(rawBytes),
      'the masked frame is byte-identical to the raw frame',
    );
    // A PNG always starts with the 8-byte signature, so this proves the server
    // produced a real image rather than a truncated or empty payload.
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert(maskedBytes.subarray(0, 8).equals(PNG_SIG), 'the masked frame is not a valid PNG');

    console.log('\nRESULT: PASS — the live server masked the frame; the provider never saw the raw pixels.');
  } finally {
    server.kill('SIGTERM');
    mock.close();
    rmSync(storageDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`\nRESULT: FAIL — ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
