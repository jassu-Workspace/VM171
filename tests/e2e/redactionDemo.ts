/**
 * Visual proof of server-side redaction.
 *
 * Renders a realistic page containing obviously-sensitive values, runs the REAL
 * redaction pipeline (server/src/redaction.ts) over it, and writes three
 * images:
 *
 *   1-before.png   the frame as captured
 *   2-annotated.png  the detections drawn as outlines, so you can see WHAT the
 *                    model found and judge whether it is finding the right things
 *   3-after.png    the frame the provider actually receives
 *
 * The third image is produced by the same code path the server uses on
 * /api/step — no mock, no stub.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSensitiveRegions, applyRedaction, isRedactionAvailable } from '../../server/src/redaction';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = '/mnt/disk3/171/redaction-demo';
const W = 900;
const H = 620;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// A page that looks like a real checkout/banking form, because that is what the
// detector is trained on. A synthetic white rectangle proves nothing.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:#f1f3f6; color:#1a1a1a; }
  .nav { background:#0b1f3a; color:#fff; padding:14px 28px; font-weight:600; font-size:15px; }
  .wrap { max-width:840px; margin:22px auto; background:#fff; border-radius:10px;
          box-shadow:0 1px 4px rgba(0,0,0,.12); overflow:hidden; }
  h1 { font-size:20px; margin:0; padding:20px 28px 4px; }
  .sub { color:#5a6472; font-size:13px; padding:0 28px 16px; }
  form { padding:8px 28px 26px; }
  .row { display:flex; gap:16px; margin-bottom:15px; }
  .field { flex:1; }
  label { display:block; font-size:12px; font-weight:600; margin-bottom:5px; color:#374151; }
  input, select { width:100%; padding:9px 11px; font-size:14px; border:1px solid #cbd2d9;
                  border-radius:6px; background:#fff; color:#111; }
  .btn { background:#0b5fff; color:#fff; border:0; padding:11px 22px; font-size:15px;
         font-weight:600; border-radius:6px; cursor:pointer; }
  .total { font-size:22px; font-weight:700; padding:14px 0; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-bottom:12px; }
  td, th { padding:9px 10px; border-bottom:1px solid #e5e7eb; text-align:left; }
  th { color:#5a6472; font-size:11px; text-transform:uppercase; letter-spacing:.4px; }
  .muted { color:#6b7280; font-size:12px; }
</style></head>
<body>
  <div class="nav">Northwind Bank &nbsp;·&nbsp; Secure Checkout</div>
  <div class="wrap">
    <h1>Complete your payment</h1>
    <div class="sub">Order #NW-88213-4471 &nbsp;·&nbsp; Encrypted in transit</div>
    <form>
      <div class="row">
        <div class="field">
          <label>Cardholder name</label>
          <input value="Priya Raghunathan">
        </div>
        <div class="field">
          <label>Card number</label>
          <input value="4539 8821 0043 7761">
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>Expiry</label>
          <input value="11 / 29">
        </div>
        <div class="field">
          <label>CVV</label>
          <input value="418">
        </div>
        <div class="field">
          <label>Email for receipt</label>
          <input value="p.raghunathan@northwind-logistics.in">
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>Billing address</label>
          <input value="221B Baker Street, Marylebone">
        </div>
        <div class="field">
          <label>Sort code</label>
          <input value="20-45-77">
        </div>
        <div class="field">
          <label>Account number</label>
          <input value="81726354">
        </div>
      </div>
      <table>
        <tr><th>Item</th><th>Qty</th><th>Amount</th></tr>
        <tr><td>Annual subscription</td><td>1</td><td>GBP 249.00</td></tr>
        <tr><td>Priority support</td><td>1</td><td>GBP 60.00</td></tr>
      </table>
      <div class="total">Total &nbsp; GBP 309.00</div>
      <button class="btn">Pay GBP 309.00</button>
      <div class="muted" style="margin-top:12px">
        By paying you agree to the terms. Refunds are available within 30 days.
      </div>
    </form>
  </div>
</body></html>`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const available = await isRedactionAvailable();
  assert(available, 'onnxruntime-node unavailable — redaction cannot run');
  console.log('[demo] redaction runtime available');

  const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    await page.setContent(PAGE);
    const png = await page.screenshot({ type: 'png' });
    writeFileSync(join(OUT, '1-before.png'), png);
    console.log(`[demo] captured the page -> 1-before.png (${png.length} bytes)`);

    // Decode to RGBA the same way the server does.
    const arr = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return { w: img.width, h: img.height, d: Array.from(ctx.getImageData(0, 0, img.width, img.height).data) };
    }, png.toString('base64'));

    const rgba = Uint8ClampedArray.from(arr.d);
    console.log(`[demo] decoded ${arr.w}x${arr.h}`);

    // What did the model actually find? This is the step worth seeing, because
    // a masking routine can return plausible boxes over the wrong regions and
    // still look correct in aggregate.
    const detection = await detectSensitiveRegions(rgba, arr.w, arr.h);
    assert(detection.ok, `detection failed: ${detection.ok ? '' : detection.reason}`);
    console.log(`[demo] ${detection.regions.length} region(s) in ${detection.inferenceMs}ms`);
    for (const r of detection.regions) {
      const [x, y, w, h] = r.bbox.map((v) => Math.round(v));
      console.log(`        ${r.className.padEnd(12)} ${r.confidence.toFixed(2)}  [${x},${y} ${w}x${h}]`);
    }

    // 2 + 3. Draw overlays in the browser, but hand the pixels over as a
    // data URL built in CHUNKS — spreading a 2.2M-element array into
    // String.fromCharCode overflows the stack.
    const rawB64 = png.toString('base64');

    const toUrl = async (pixels: Uint8ClampedArray): Promise<string> =>
      page.evaluate(
        async ({ b64, extra, w, h }: { b64: string; extra: unknown; w: number; h: number }) => {
          const img = new Image();
          img.src = 'data:image/png;base64,' + b64;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const x = c.getContext('2d')!;
          x.drawImage(img, 0, 0);
          const boxes = (extra as { boxes?: { bbox: number[]; confidence: number; className: string }[] })?.boxes ?? [];
          for (const b of boxes) {
            const [bx, by, bw, bh] = b.bbox;
            x.lineWidth = 2;
            x.strokeStyle = 'rgba(220,38,38,.95)';
            x.strokeRect(bx, by, bw, bh);
            x.fillStyle = 'rgba(220,38,38,.95)';
            x.font = 'bold 11px sans-serif';
            x.fillText(`${b.className} ${b.confidence.toFixed(2)}`, bx + 2, Math.max(11, by - 3));
          }
          return c.toDataURL('image/png').split(',')[1];
        },
        { b64: rawB64, extra: { boxes: detection.regions }, w: arr.w, h: arr.h },
      );

    const annotated = await toUrl(rgba);
    writeFileSync(join(OUT, '2-annotated.png'), Buffer.from(annotated, 'base64'));
    console.log('[demo] wrote 2-annotated.png with the detections outlined');

    // 3. the frame the provider actually receives.
    const masked = Uint8ClampedArray.from(rgba);
    const painted = applyRedaction(masked, arr.w, arr.h, detection.regions);

    const afterB64 = await page.evaluate(
      async ({ b64, patch, w, h }: { b64: string; patch: number[]; w: number; h: number }) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const x = c.getContext('2d')!;
        x.drawImage(img, 0, 0);
        const id = x.getImageData(0, 0, w, h);
        // Only the painted pixels are sent across, not the whole frame.
        for (let i = 0; i < patch.length; i += 4) {
          id.data[i] = patch[i];
          id.data[i + 1] = patch[i + 1];
          id.data[i + 2] = patch[i + 2];
          id.data[i + 3] = 255;
        }
        x.putImageData(id, 0, 0);
        return c.toDataURL('image/png').split(',')[1];
      },
      { b64: rawB64, patch: Array.from(masked), w: arr.w, h: arr.h },
    );
    writeFileSync(join(OUT, '3-after.png'), Buffer.from(afterB64, 'base64'));

    let changed = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] !== masked[i] || rgba[i + 1] !== masked[i + 1] || rgba[i + 2] !== masked[i + 2]) changed += 1;
    }
    console.log(
      `[demo] painted ${painted} region(s); ${changed} px destroyed ` +
      `(${((100 * changed) / (W * H)).toFixed(1)}% of the frame)`,
    );
    console.log('[demo] wrote 3-after.png — this is what the provider receives');
    console.log(`\nDone. Images in ${OUT}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
