/**
 * Ambient declarations for the WXT auto-imports this project uses.
 *
 * WHY THIS FILE EXISTS
 *
 * WXT generates `.wxt/types/imports.d.ts` with ambient declarations for
 * `defineBackground`, `defineContentScript` and friends. Two problems with
 * depending on it:
 *
 *   1. `.wxt` is a DOT-DIRECTORY, and TypeScript's `include` globs skip dot
 *      directories by default — so it was never loaded, which is part of why
 *      `defineBackground` was reported as undefined.
 *   2. The committed copy is STALE and full of the original build machine's
 *      absolute Windows paths (`typeof import('C:/sih/171/extension/src/...')`).
 *      Loading it would add ~50 unresolvable imports on any other machine.
 *
 * It is generated output and is gitignored, so the declarations are restated
 * here for the handful actually used. Re-running `wxt prepare` regenerates the
 * real file; this one is a stable, path-independent stand-in so `npm run
 * typecheck` works in a clean checkout.
 */

declare function defineBackground<T>(def: T): T;
declare function defineContentScript<T>(def: T): T;
declare function defineUnlistedScript<T>(def: T): T;
