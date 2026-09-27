# ONNX Runtime cannot run in an MV3 service worker

**Status: known platform limitation. Redaction runs DEGRADED on MV3.**
Measured on this repo, Chromium 153, `onnxruntime-web` 1.29.0.

## The error

```
no available backend found. ERR: [wasm] TypeError: import() is disallowed
on ServiceWorkerGlobalScope by the HTML specification.
See https://github.com/w3c/ServiceWorker/issues/1356.
```

Reproduced in a real browser, not inferred. `tests/e2e/modelLoad.check.ts`
loads the built extension into real Chromium and asks the live service worker
to create an `InferenceSession`.

## Why it happens

`onnxruntime-web` loads its WASM JavaScript glue with a **dynamic
`import()`**. The HTML specification forbids dynamic import inside
`ServiceWorkerGlobalScope`, so the call throws before the WASM runtime is
ever reached. "no available backend found" is the symptom; the real cause is
the dynamic import.

## What was tried

| Attempt | Result |
|---|---|
| Set `ort.env.wasm.wasmPaths` to an extension-origin URL | Necessary — the runtime files were not in the bundle at all. Still fails. |
| Import `onnxruntime-web/all` (inlines the glue) | Correct entry for a service worker. Still fails. |
| Drop the `mjs` key so the glue is not resolved by URL | Still fails. |
| Verify against the built bundle | `Gb=async e=>(await import(e)).default` survives in `background.js` and **is called on the wasm path**: `return[d?s:void 0,await Gb(`. |

The surviving call is the decisive evidence. The dynamic import is reachable
from the wasm code path even in the "bundle" build, so no bundler
configuration or path setting can remove it. This is a platform restriction,
not a packaging mistake.

## The bug that hid this

`checkModelAvailability()` only issued a byte-range GET:

```ts
const res = await fetch(MODEL_URL, { headers: { Range: 'bytes=0-0' } });
return res.ok || res.status === 206;
```

That proves the `.onnx` file is *present*. It says nothing about whether the
runtime can *execute*. So the availability check reported
`{ui: true, face: true, ocr: true}` — "Sovereign models available" — while
every model was failing to initialise and **no PII was being masked**.

This is the dangerous part: the product's central claim is that sensitive
data is redacted locally, and the status UI contradicted that claim while the
claim was false.

## What changed anyway

- `checkModelRuntimeUsable()` creates a real `InferenceSession` and is now
  required before the UI/OCR models are reported `live`. Bounded at 30s so a
  hung create cannot park the service worker.
- When the runtime is unusable the agent logs a warning and the models stay
  `degraded`, so the UI reports the truth.
- The runtime ships in the bundle and `ort/*` is web-accessible, so the
  *packaging* half of the bug is genuinely fixed and a future runtime that
  does work will not hit it.

## Options, with trade-offs

None of these is implemented. Each changes the privacy posture, so the
choice is a product decision, not a bug fix.

1. **Run inference in an offscreen document instead of the service worker.**
   A DOM context allows dynamic import. Most promising: keeps everything
   local, no server change. Costs a document per extension, and screenshots
   would have to be transferred to it.

2. **Move redaction to the local server.**
   The server is Node, where WASM is not restricted. Keeps the model files
   out of the extension. But frames are already sent to the server, so this
   changes nothing about what leaves the browser — it only changes where
   masking happens. Cheapest path to working redaction.

3. **Move the agent loop out of the service worker into a persistent page.**
   Architecturally the cleanest, since a DOM context is not restricted. A
   large refactor: the service worker is what makes the extension survive
   navigation.

4. **Switch runtime.** `onnxruntime-web/webgl` ships with **zero** dynamic
   imports (verified: only `ort.webgl.mjs` and `ort.webgl.min.mjs` have none).
   Needs WebGL in a service worker, which is supported, and re-validates the
   model set.

5. **Pin an older `onnxruntime-web`** that predates the dynamic import.
   Unverified — would need a bisect across versions.

## Recommendation

Option 2 for correctness now, option 1 or 4 for a proper fix. In the
meantime, the honest status reporting from this change means the UI no longer
claims redaction is working when it is not.
