/**
 * Does server-side redaction actually WORK?
 *
 * Not "does it import" — does it detect regions in a REAL rendered page and
 * destroy the pixels underneath them. A masking routine that runs, returns
 * zero regions, and reports success is worse than one that fails loudly,
 * because it looks like redaction while masking nothing.
 *
 * The fixture is an actual form with labelled inputs, because a synthetic
 * white bar is not what this detector was trained on: an earlier version of
 * this test used one and correctly concluded nothing was wrong with the code
 * when in fact the model simply had nothing to detect.
 */
import { chromium } from 'playwright';
import { detectSensitiveRegions, applyRedaction, isRedactionAvailable } from '../../server/src/redaction';

const W = 640;
const H = 640;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function renderForm(): Promise<Uint8ClampedArray> {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    await page.setContent(`<!doctype html><body style="margin:0;font-family:sans-serif;background:#fff">
      <form style="padding:24px">
        <label>Full name</label><br><input style="width:280px;padding:6px" value="Jane Doe"><br><br>
        <label>Email</label><br><input style="width:280px;padding:6px" value="jane@example.com"><br><br>
        <label>Card number</label><br><input style="width:280px;padding:6px" value="4111 1111 1111 1111"><br><br>
        <button style="padding:8px 20px">Submit payment</button>
      </form></body>`);
    const shot = await page.screenshot({ type: 'png' });
    const url = `data:image/png;base64,${shot.toString('base64')}`;
    const arr = await page.evaluate(async (u) => {
      const img = new Image();
      img.src = u;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
    }, url);
    return Uint8ClampedArray.from(arr);
  } finally {
    await browser.close();
  }
}

async function main() {
  const available = await isRedactionAvailable();
  console.log('isRedactionAvailable():', available);
  assert(available, 'onnxruntime-node did not load — redaction cannot run');

  const rgba = await renderForm();
  console.log(`rendered a ${W}x${H} form with 3 inputs and a button`);

  const result = await detectSensitiveRegions(rgba, W, H);
  assert(result.ok, `detection failed: ${result.ok ? '' : result.reason}`);
  const { regions, inferenceMs } = result;
  console.log(`detected ${regions.length} region(s) in ${inferenceMs}ms`);
  assert(regions.length > 0, 'no regions found on a form with three inputs — nothing would be masked');

  const byClass = new Map<string, number>();
  for (const r of regions) byClass.set(r.className, (byClass.get(r.className) ?? 0) + 1);
  console.log('classes:', JSON.stringify(Object.fromEntries(byClass)));

  // every box must be a real, in-bounds rectangle
  for (const r of regions) {
    const [x, y, w, h] = r.bbox;
    assert(w > 0 && h > 0, `degenerate box ${JSON.stringify(r.bbox)}`);
    assert(x >= -1 && y >= -1, `box starts outside the frame: ${JSON.stringify(r.bbox)}`);
    assert(x + w <= W + 1 && y + h <= H + 1, `box exceeds the frame: ${JSON.stringify(r.bbox)}`);
  }

  // at least one high-confidence detection — proves the model is engaged
  const best = Math.max(...regions.map((r) => r.confidence));
  console.log('highest confidence:', best.toFixed(3));
  assert(best > 0.5, `no confident detection (best ${best.toFixed(3)})`);

  // masking must actually change pixels
  const before = Uint8ClampedArray.from(rgba);
  const painted = applyRedaction(rgba, W, H, regions);
  console.log(`applyRedaction painted ${painted} region(s)`);
  assert(painted > 0, 'nothing painted — the frame would go upstream un-redacted');

  let changed = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] !== before[i] || rgba[i + 1] !== before[i + 1] || rgba[i + 2] !== before[i + 2]) {
      changed += 1;
    }
  }
  const pct = (100 * changed) / (W * H);
  console.log(`pixels changed: ${changed} (${pct.toFixed(1)}% of the frame)`);
  assert(changed > 1000, `only ${changed} pixels changed — masking is not meaningful`);

  // a pixel with no detection over it must be untouched, proving the fill is
  // targeted rather than blanketing the frame
  let untouched = 0;
  for (let y = 600; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      if (rgba[i] === before[i] && rgba[i + 1] === before[i + 1] && rgba[i + 2] === before[i + 2]) {
        untouched += 1;
      }
    }
  }
  const bandPct = (100 * untouched) / (W * 40);
  console.log(`bottom band untouched: ${bandPct.toFixed(1)}%`);
  assert(bandPct > 90, 'the bottom band was masked even though nothing was detected there');

  console.log('\nRESULT: PASS — server-side redaction detects real form fields and destroys the pixels beneath them.');
}

main().catch((e) => {
  console.error(`\nRESULT: FAIL — ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
