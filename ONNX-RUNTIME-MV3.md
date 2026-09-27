# ONNX Runtime cannot run the redaction models in this extension

**Status: the models cannot execute in the extension on any backend.
Redaction does not work. This is not a packaging bug.**

Measured on this repo, Chromium 153, `onnxruntime-web` 1.29.0, using
`tests/e2e/modelLoad.check.ts` against the real built extension.

There are TWO independent blockers. The first is fixable and was fixed. The
second is not fixable by configuration.

## Blocker 1 — the WASM backend cannot initialise in a service worker

```
no available backend found. ERR: [wasm] TypeError: import() is disallowed
in a service worker by the HTML specification.
```

`onnxruntime-web` loads its WASM JavaScript glue with a **dynamic
`import()`**. The HTML specification forbids dynamic import in a service
worker, so the call throws before the WASM runtime is reached. "No available
backend found" is the symptom; the dynamic import is the cause.

Attempted, and verified insufficient:

| Attempt | Result |
|---|---|
| Set `ort.env.wasm.wasmPaths` to an extension-origin URL | Necessary — the runtime files were not in the bundle at all. Still fails. |
| Import `onnxruntime-web/all` (inlines the glue) | Correct entry for a service worker. Still fails. |
| Drop the `mjs` key so the glue is not resolved by URL | Still fails. |
| Verify against the built bundle | `Gb=async e=>(await import(e)).default` survives in `background.js` and **is called on the wasm path**: `return[d?s:void 0,await Gb(`. |
| **`onnxruntime-web/webgl`** (zero dynamic imports) | **Runtime initialises. FIXED.** |

`webgl` is the only ORT build with zero dynamic imports. The built bundle now
contains zero `import(` calls, and the runtime genuinely initialises.

`webgl` must also be the FIRST requested provider — asking for `wasm` first
fails outright rather than degrading. `hardwareTier` now orders providers
`[webgpu?, webgl, wasm]`.

## Blocker 2 — the models need an operator no ORT build implements

With the runtime finally initialising, session creation gets further and then
fails on the model itself:

```
cannot resolve operator 'DynamicQuantizeLinear' with opsets: ai.onnx v17
```

All three models are **dynamically quantized** — each contains
`DynamicQuantizeLinear` and `QuantizeLinear`:

| model | size | quantized ops present |
|---|---|---|
| `ui_detector.onnx` | 11.5 MB | `DynamicQuantizeLinear`, `QuantizeLinear` |
| `ocr_det.onnx` | 198 KB | `DynamicQuantizeLinear`, `QuantizeLinear` |
| `ocr_rec.onnx` | 29 MB | `DynamicQuantizeLinear`, `QuantizeLinear` |

The operator is **absent from every shipped ORT build**, not only webgl:

```
webgl    DynamicQuantizeLinear present: False
all      DynamicQuantizeLinear present: False
```

And it is **not** fixed by upgrading. Checked against the newest available
build, `1.31.0-dev.20260918-bc8e7ed75`:

```
package/dist/ort.all.bundle.min.mjs   DynamicQuantizeLinear: 0
package/dist/ort.webgl.min.mjs        DynamicQuantizeLinear: 0
```

So this is a model/runtime mismatch, not a version lag. **No provider,
bundler, or path setting can bridge it.** It needs different models, or
inference outside the extension.

The models arrived pre-quantized in the first commit and have never loaded.
This is not a regression — it is a long-standing broken state that the status
UI was concealing.

## The bug that concealed it

`checkModelAvailability()` only issued a byte-range GET:

```ts
const res = await fetch(MODEL_URL, { headers: { Range: 'bytes=0-0' } });
return res.ok || res.status === 206;
```

That proves the `.onnx` is *present*. It says nothing about whether the
runtime can *execute*. So the availability check reported
`{ui: true, face: true, ocr: true}` — "Sovereign models available" — while
every model was failing to initialise and **no PII was being masked**.

This is the dangerous part: the product's central claim is that sensitive
data is redacted locally, and the status UI contradicted that claim while the
claim was false. For a zero-trust product that is the worst available failure
mode.

## What changed

- `checkModelRuntimeUsable()` creates a real `InferenceSession` and is required
  before the UI/OCR models report `live`. Bounded at 30s so a hung create
  cannot park the service worker, which would be the same silent-failure mode
  one level down.
- When the runtime is unusable the agent logs a warning and the models stay
  `degraded`, so the UI reports the truth.
- The runtime ships in the bundle and `ort/*` is web-accessible, so the
  packaging half is genuinely fixed and a future working runtime will not hit
  it.
- `onnxruntime-web/webgl` and the corrected provider ordering, so blocker 1
  cannot recur.

## Options

None of these is implemented. Each changes the privacy posture or the model
set, so it is a product decision rather than a bug fix.

1. **Re-export the models without dynamic quantization.** The unquantized
   upstream exports avoid `DynamicQuantizeLinear` entirely. Costs file size
   and inference speed. Requires a source for the original exports.

2. **Run redaction on the local server.** The server is Node, where WASM has no
   dynamic-import restriction and `onnxruntime-node` supports current opsets.
   Frames are **already** sent to the server, so nothing new leaves the
   browser — this only moves *where masking happens*. It also lets the server
   gate the agent on "redaction succeeded" rather than trusting a client-side
   status. The most reliable path to working redaction.

3. **Offscreen document.** A DOM context allows dynamic import, so the WASM
   backend works there. Keeps everything local, but still hits blocker 2, so
   it only helps in combination with option 1.

4. **MV2 instead of MV3.** Would remove the dynamic-import restriction, but
   still hits blocker 2, and MV2 is being withdrawn from the Web Store.

## Recommendation

**Option 2.** It is the only one that solves both blockers, needs no new model
source, and does not weaken the privacy posture: frames are already
transmitted locally, and the server becomes the authority on whether
redaction actually happened.

Until one of these lands, the extension cannot mask PII. The status UI
correctly says so, which is the honest state.
