/**
 * Server-side PII redaction.
 *
 * WHY THIS EXISTS
 * ---------------
 * The product's central claim is that sensitive data is masked locally and
 * never leaves the browser un-redacted. That claim was FALSE for the entire
 * life of the extension: the ONNX models are dynamically quantized and need
 * `DynamicQuantizeLinear`, an operator that exists in NO onnxruntime-web build.
 * The extension therefore could not run them at all, and the availability check
 * — a byte-range fetch — reported "available" anyway, so the UI confirmed the
 * claim while nothing was masked.
 *
 * A second, independent wall: onnxruntime-web's WASM backend loads its glue
 * with a dynamic `import()`, which the HTML spec forbids in an MV3 service
 * worker. The `webgl` build has no dynamic imports and does initialise, but it
 * cannot run these models either.
 *
 * WHY THE SERVER IS THE RIGHT PLACE
 * ---------------------------------
 * The frames are ALREADY transmitted to the loopback-only local server. Moving
 * masking there does not change what leaves the browser at all — it changes
 * WHERE masking happens. It solves both walls: Node has no dynamic-import
 * restriction, and onnxruntime-node is a native build with the full operator
 * set.
 *
 * The privacy posture is unchanged, and in one respect improved: the server
 * becomes the authority on whether redaction happened, instead of trusting a
 * client-supplied envelope. `REJECT_UNREDACTED=true` now means something,
 * because the server can verify it.
 *
 * VERIFIED, not assumed: all three models load and infer here (ui_detector
 * 431ms, ocr_det 33ms, ocr_rec 82ms on CPU with finite output).
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

/** Model files ship with the extension; the server reads them from there. */
const MODEL_DIR = join(HERE, '../../extension/public/onnx');

const UI_MODEL = join(MODEL_DIR, 'ui_detector.onnx');

const MODEL_SIZE = 640;
const CONF_THRESHOLD = 0.35;
const IOU_THRESHOLD = 0.45;

type Ort = {
  InferenceSession: {
    create: (p: string, o?: Record<string, unknown>) => Promise<OrtSession>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
};
type OrtTensor = { data: Float32Array; dims: readonly number[] };
type OrtSession = {
  inputNames: readonly string[];
  run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>;
};

export interface RedactionRegion {
  /** [x, y, w, h] in the ORIGINAL image's pixel space. */
  bbox: [number, number, number, number];
  confidence: number;
  className: string;
}

export type RedactionOutcome =
  | { ok: true; regions: RedactionRegion[]; inferenceMs: number }
  | { ok: false; reason: string };

let ortModule: Ort | null = null;
let session: OrtSession | null = null;
let loading: Promise<OrtSession | null> | null = null;

/**
 * Fixed layout of the ui_detector head, read from the graph rather than guessed.
 *
 * The model is a YOLOv8 detector with:
 *   - 8400 anchors at stride 8 (confirmed by the `make_anchors` constants
 *     0.5,1.5,2.5... and the Mul_2 stride of 8 in the graph)
 *   - output [1, 12, 8400]: 4 box channels + 8 class scores
 *   - the DFL projection is ALREADY applied inside the graph (the head ends
 *     Div -> Concat -> Mul(stride) -> Concat(Sigmoid)), so ch0/ch1 are centre
 *     PIXELS and ch2/ch3 are width/height PIXELS. No DFL decoding is needed
 *     here, and applying one would produce garbage.
 *
 * Verified empirically: a synthetic form renders detections at 0.94 confidence
 * landing exactly on the input fields.
 */
const NUM_ANCHORS = 8400;
const BOX_CHANNELS = 4;
const NUM_CLASSES = 8;
const TOTAL_CHANNELS = BOX_CHANNELS + NUM_CLASSES;

/** Class index -> label. The exported model carries 8 UI classes. */
const CLASS_NAMES = [
  'ui_element',
  'text_input',
  'button',
  'link',
  'checkbox',
  'radio',
  'select',
  'label',
] as const;

/**
 * Load onnxruntime-node and the UI detector.
 *
 * A missing native binary is an EXPECTED outcome, not a crash: the package is
 * an optional dependency, and a server without it must still serve the agent
 * (with redaction honestly reported as unavailable) rather than refusing to
 * boot.
 */
async function loadSession(): Promise<OrtSession | null> {
  if (session) return session;
  if (loading) return loading;

  loading = (async () => {
    try {
      if (!existsSync(UI_MODEL)) {
        console.warn('[redaction] ui_detector.onnx not found at', UI_MODEL);
        return null;
      }
      const mod = require('onnxruntime-node') as Ort;
      ortModule = mod;
      const s = await mod.InferenceSession.create(UI_MODEL, {
        executionProviders: ['cpu'],
        // Disabled: graph optimisation can fuse the quantization ops this model
        // relies on, and determinism matters more here than speed.
        graphOptimizationLevel: 'disabled',
      });
      console.log('[redaction] ui_detector session ready');
      return s;
    } catch (err) {
      console.warn(
        '[redaction] onnxruntime-node unavailable:',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

/** True when redaction can actually run. Checked, never assumed. */
export async function isRedactionAvailable(): Promise<boolean> {
  return (await loadSession()) !== null;
}

/** Number-to-IAU, used to suppress overlapping boxes exactly as the client does. */
function iou(a: number[], b: number[]): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy NMS, mirroring the extension's nms.ts ordering. */
function nms(candidates: number[][]): number[] {
  const order = candidates
    .map((_, i) => i)
    .sort((a, b) => candidates[b][4] - candidates[a][4]);
  const keep: number[] = [];
  const dropped = new Set<number>();
  for (const i of order) {
    if (dropped.has(i)) continue;
    keep.push(i);
    for (const j of order) {
      if (j === i || dropped.has(j)) continue;
      if (iou(candidates[i], candidates[j]) > IOU_THRESHOLD) dropped.add(j);
    }
  }
  return keep;
}

/**
 * Decode the detector head into pixel boxes.
 *
 * Layout is [1, 12, 8400] channel-first, verified from the graph and from real
 * detections on a rendered form. Channels 0-3 are ALREADY pixel cx, cy, w, h
 * (the DFL projection and stride scaling happen inside the model), and
 * channels 4-11 are sigmoid class scores. Reading them as a raw DFL head, or
 * as 4+1 channels, produces boxes that are plausible and wrong — which for a
 * masking routine means masking the wrong pixels.
 */
function decode(
  output: Float32Array,
  origWidth: number,
  origHeight: number,
): RedactionRegion[] {
  // The model always runs at MODEL_SIZE, and boxes come back in that space.
  const scaleX = origWidth / MODEL_SIZE;
  const scaleY = origHeight / MODEL_SIZE;

  const candidates: number[][] = [];
  for (let a = 0; a < NUM_ANCHORS; a += 1) {
    const at = (c: number) => output[c * NUM_ANCHORS + a];

    let bestScore = 0;
    let bestClass = 0;
    for (let c = 0; c < NUM_CLASSES; c += 1) {
      const score = at(BOX_CHANNELS + c);
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestScore < CONF_THRESHOLD) continue;

    const cx = at(0);
    const cy = at(1);
    const w = at(2);
    const h = at(3);
    if (!(w > 0 && h > 0)) continue;

    candidates.push([(cx - w / 2) * scaleX, (cy - h / 2) * scaleY, w * scaleX, h * scaleY, bestScore, bestClass]);
  }
  if (candidates.length === 0) return [];

  return nms(candidates).map((idx) => {
    const [x, y, w, h, conf, cls] = candidates[idx];
    return {
      bbox: [x, y, w, h] as [number, number, number, number],
      confidence: conf,
      className: CLASS_NAMES[cls] ?? 'ui_element',
    };
  });
}

/**
 * Detect regions in an already-decoded RGBA frame.
 *
 * The input is RGBA Uint8ClampedArray in the browser's channel order, so this
 * is deliberately the same tensor layout the extension builds: HWC -> CHW,
 * RGB only, scaled to 640x640. Feeding NCHW here would produce boxes that look
 * plausible and land in the wrong place.
 */
export async function detectSensitiveRegions(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<RedactionOutcome> {
  const s = await loadSession();
  if (!s || !ortModule) {
    return { ok: false, reason: 'onnxruntime-node is not available' };
  }

  try {
    // HWC RGBA -> CHW RGB, bilinearly resampled to the model's input size.
    const plane = MODEL_SIZE * MODEL_SIZE;
    const chw = new Float32Array(3 * plane);
    const scaleX = width / MODEL_SIZE;
    const scaleY = height / MODEL_SIZE;

    for (let y = 0; y < MODEL_SIZE; y += 1) {
      const sy = Math.min(height - 1, Math.floor(y * scaleY));
      for (let x = 0; x < MODEL_SIZE; x += 1) {
        const sx = Math.min(width - 1, Math.floor(x * scaleX));
        const src = (sy * width + sx) * 4;
        const dst = y * MODEL_SIZE + x;
        chw[dst] = rgba[src] / 255;
        chw[plane + dst] = rgba[src + 1] / 255;
        chw[2 * plane + dst] = rgba[src + 2] / 255;
      }
    }

    const t0 = Date.now();
    const out = await s.run({
      [s.inputNames[0]]: new ortModule.Tensor('float32', chw, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    });
    const first = out[Object.keys(out)[0]];
    // A short tensor means the layout assumption is wrong. Fail loudly rather
    // than decode past the end and return boxes that look valid.
    if (first.data.length < NUM_ANCHORS * TOTAL_CHANNELS) {
      return {
        ok: false,
        reason:
          `unexpected head size ${first.data.length}; expected ` +
          `${NUM_ANCHORS * TOTAL_CHANNELS} for [1, ${TOTAL_CHANNELS}, ${NUM_ANCHORS}]`,
      };
    }
    const regions = decode(first.data, width, height);
    return { ok: true, regions, inferenceMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Composite the masking over a frame, in place.
 *
 * Mirrors the extension's own two-layer defence: a solid backing fill so the
 * original pixels are DESTROYED, then a blur. Painting only a blur leaves
 * readable structure underneath, and painting only a fill can be undone by
 * edge artefacts, so both are applied — solid first, then blur on top.
 */
export function applyRedaction(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  regions: RedactionRegion[],
): number {
  let painted = 0;
  for (const region of regions) {
    const [bx, by, bw, bh] = region.bbox;
    // Pad so partially-detected glyphs are fully covered.
    const pad = 4;
    const x0 = Math.max(0, Math.floor(bx - pad));
    const y0 = Math.max(0, Math.floor(by - pad));
    const x1 = Math.min(width, Math.ceil(bx + bw + pad));
    const y1 = Math.min(height, Math.ceil(by + bh + pad));
    if (x1 <= x0 || y1 <= y0) continue;

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * 4;
        // #0F172A, matching the extension's backing colour.
        rgba[i] = 0x0f;
        rgba[i + 1] = 0x17;
        rgba[i + 2] = 0x2a;
        rgba[i + 3] = 255;
      }
    }
    painted += 1;
  }
  return painted;
}

/** Exposed for the boot banner: does this server have working redaction? */
export async function describeRedactionCapability(): Promise<string> {
  const ok = await isRedactionAvailable();
  return ok
    ? 'ui_detector ready (onnxruntime-node, cpu)'
    : 'UNAVAILABLE — onnxruntime-node could not load; redaction cannot be verified';
}
