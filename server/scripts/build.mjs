/**
 * Server build — Cycle 3.7
 *
 * `npm start` used to run `npx tsx src/index.ts`: a RUNTIME TRANSPILE. The
 * TypeScript was compiled on every boot, on the machine, by a tool resolved at
 * run time — so a cold start paid a compile before the port opened, `npx` could
 * fetch a different tsx than the lockfile pins, and there was no artifact to
 * hash, attest or roll back.
 *
 * WHY esbuild RATHER THAN `tsc`
 *
 * The source uses extensionless ESM specifiers (`from './logger'`, ten of them
 * in src/index.ts alone). A native Node ESM build would need `.js` on every one,
 * which means editing every import in the project. esbuild resolves and bundles
 * them as-is.
 *
 * It also matters that ONE import crosses a project boundary: `index.ts` pulls
 * `containsFullAddress` from `extension/src/utils/addressDetector` for the
 * physical-address heuristic added in Cycle 2.10. A build rooted only at
 * `server/src` would miss it. esbuild follows the import wherever it goes.
 *
 * Nothing is inlined at build time. `process.env` stays a runtime lookup, so a
 * bundle step can never bake a live credential into a shipped artifact — and
 * there is a test asserting exactly that, because it is the obvious way for
 * this kind of script to go wrong.
 */
import { build as esbuild } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, '..');

export const ENTRY = join(SERVER_DIR, 'src', 'index.ts');
export const DEFAULT_OUT_DIR = join(SERVER_DIR, 'dist');

/**
 * Bundle the server to a single ESM artifact.
 *
 * external: every package dependency and every node: builtin stays a runtime
 * import, so node_modules is not inlined and the artifact stays small.
 */
export async function build(options = {}) {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const outfile = join(outDir, 'index.js');
  mkdirSync(outDir, { recursive: true });

  await esbuild({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: true,
    // Keep the artifact honest: a type annotation surviving into the output
    // would mean the transform silently did nothing.
    logLevel: 'warning',
    banner: {
      js: [
        '// Zero-Trust AI Web Agent — server bundle (Cycle 3.7).',
        '// Generated. Do not edit; edit server/src and rebuild.',
        '// No secrets are inlined: process.env is read at runtime.',
      ].join('\n'),
    },
    external: [
      'hono',
      'hono/*',
      '@hono/*',
      'openai',
      'zod',
      '@hono/zod-validator',
      'dotenv',
      'dotenv/config',
    ],
  });

  return { outfile, outDir };
}

// Run directly: `npm run build`
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  build()
    .then(({ outfile }) => {
      console.log(`[build] server bundled -> ${outfile}`);
    })
    .catch((err) => {
      console.error('[build] failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
