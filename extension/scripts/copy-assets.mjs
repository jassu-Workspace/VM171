/**
 * copy-assets.mjs — Copies static ML assets from public/ to the WXT build output.
 *
 * WXT does NOT automatically copy public/ subdirectories to .output/chrome-mv3/,
 * so this script runs as a postbuild hook to ensure model files are present.
 *
 * Run automatically via: npm run build (postbuild hook)
 */

import { mkdir, copyFile, access, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const OUTPUT_DIR = join(ROOT, '.output', 'chrome-mv3');

/** Directories to copy from public/ to build output */
const ASSET_DIRS = ['mediapipe', 'onnx'];

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(srcDir, destDir) {
  const entries = await readdir(srcDir, { withFileTypes: true });
  let copied = 0;
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += await copyDir(srcPath, destPath);
    } else {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
      copied++;
      console.log(`  [copied] ${relative(ROOT, srcPath)} -> ${relative(ROOT, destPath)}`);
    }
  }
  return copied;
}

// Import readdir from fs/promises
import { readdir } from 'node:fs/promises';

async function main() {
  console.log('📦 copy-assets — copying ML model files to build output\n');

  if (!(await fileExists(PUBLIC_DIR))) {
    console.warn(`  [warn] public/ directory not found at ${PUBLIC_DIR}`);
    return;
  }

  if (!(await fileExists(OUTPUT_DIR))) {
    console.warn(`  [warn] Build output not found at ${OUTPUT_DIR}. Run wxt build first.`);
    return;
  }

  let totalCopied = 0;
  for (const dir of ASSET_DIRS) {
    const srcDir = join(PUBLIC_DIR, dir);
    const destDir = join(OUTPUT_DIR, dir);
    if (await fileExists(srcDir)) {
      // Clean destination first to prevent stale/nested duplicates
      if (await fileExists(destDir)) {
        await rm(destDir, { recursive: true, force: true });
      }
      console.log(`  [copy] ${dir}/`);
      totalCopied += await copyDir(srcDir, destDir);
    } else {
      console.log(`  [skip] ${dir}/ not found in public/`);
    }
  }

  // The onnxruntime-web WASM runtime, copied out of node_modules.
  //
  // This was missing entirely, which is why every model degraded in the
  // service worker. ORT resolves its runtime lazily from wasmPaths; the paths
  // were never set, so it fell back to XMLHttpRequest, which an MV3 service
  // worker does not have ("XMLHttpRequest is not defined"). The models then
  // silently failed to load — meaning PII was NOT being masked while the UI
  // reported the agent as ready.
  //
  // Only the single-threaded build is taken. numThreads is 1 because
  // SharedArrayBuffer is unavailable without cross-origin isolation, and the
  // asyncify/jsep/jspi variants are for features this extension does not use.
  const ORT_SRC = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
  const ORT_DEST = join(OUTPUT_DIR, 'ort');
  const ORT_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];
  if (await fileExists(ORT_SRC)) {
    if (await fileExists(ORT_DEST)) {
      await rm(ORT_DEST, { recursive: true, force: true });
    }
    await mkdir(ORT_DEST, { recursive: true });
    console.log('  [copy] ort/');
    for (const name of ORT_FILES) {
      const src = join(ORT_SRC, name);
      if (await fileExists(src)) {
        await copyFile(src, join(ORT_DEST, name));
        totalCopied += 1;
      } else {
        // Loud, not silent: a missing runtime is a privacy failure, because
        // the models that mask PII cannot load without it.
        console.warn(`  [warn] ${name} missing from onnxruntime-web — models will degrade`);
      }
    }
  } else {
    console.warn('  [warn] onnxruntime-web not installed — models will degrade');
  }

  console.log(`\n✅ copy-assets complete. ${totalCopied} files copied.`);
}

main().catch((error) => {
  console.error('❌ copy-assets failed:', error);
  process.exit(1);
});
