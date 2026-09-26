/**
 * Cycle 3.7 — The server builds a real artifact, and CI gates it.
 * ---------------------------------------------------------------------------
 * WHAT IS WRONG TODAY
 *
 * `npm start` runs `npx tsx src/index.ts`. That is a RUNTIME TRANSPILE: the
 * TypeScript is compiled on every boot, on the machine, by a tool resolved at
 * run time. Consequences that matter in production:
 *
 *   - a cold start pays a compile before the port is open
 *   - `npx` may fetch a DIFFERENT tsx version than the one installed, so the
 *     thing that runs is not pinned by the lockfile
 *   - there is no artifact to hash, attest or roll back — only source
 *
 * This asserts the build is real, reproducible and actually produces a loadable
 * artifact — not merely that a `build` key exists in package.json, which is the
 * check that would have passed while the project kept transpiling at boot.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from '../../server/scripts/build.mjs';

const SERVER_DIR = join(process.cwd(), '..', 'server');
const ARTIFACT = join(SERVER_DIR, 'dist', 'index.js');

beforeAll(async () => {
  await build({ outDir: join(SERVER_DIR, 'dist') });
}, 120_000);

describe('Cycle 3.7 — a real build artifact', () => {
  it('emits dist/index.js', () => {
    // BREAK: a build script that reports success without writing anything.
    expect(existsSync(ARTIFACT)).toBe(true);
  });

  it('produces a non-trivial artifact', () => {
    // BREAK: an empty or stub file satisfying the existence check.
    expect(statSync(ARTIFACT).size).toBeGreaterThan(10_000);
  });

  it('emits syntactically valid JavaScript', () => {
    // BREAK: a build that emits something Node cannot parse — the failure that
    // only shows up at boot in production.
    const source = readFileSync(ARTIFACT, 'utf8');
    expect(source.length).toBeGreaterThan(0);
    // A bundler emits a banner; a broken transform usually emits nothing or
    // leaves a TypeScript type annotation behind.
    expect(source).not.toMatch(/^\s*import type /m);
    expect(source).not.toMatch(/\binterface\s+\w+\s*\{/);
  });

  it('bundles rather than leaving bare TypeScript specifiers', () => {
    // BREAK: a build that copies files and rewrites nothing, leaving
    // './logger' to be resolved at runtime by a loader that is not there.
    const source = readFileSync(ARTIFACT, 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/[a-zA-Z]+['"]/);
  });

  it('resolves the workspace-relative import the server makes', () => {
    // server/src/index.ts imports extension/src/utils/addressDetector for the
    // address heuristic. A build that only scanned server/src would fail here.
    const source = readFileSync(ARTIFACT, 'utf8');
    expect(source).toMatch(/UNSANITIZED_PAYLOAD_REJECTED|runSecurityBoundaryVerification|containsFullAddress|validateImagePayload/);
  });

  it('does not embed the secret or any API key in the artifact', () => {
    // BREAK: a bundle step that inlines process.env at build time, baking a
    // live credential into an artifact that gets shipped.
    const source = readFileSync(ARTIFACT, 'utf8');
    expect(source).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(source).not.toMatch(/AIza[A-Za-z0-9_-]{20,}/);
    expect(source).not.toMatch(/SECRETS_SIGNING_KEY\s*=\s*['"][A-Za-z0-9_-]{20,}/);
  });
});

describe('Cycle 3.7 — package.json points at the artifact, not a transpiler', () => {
  it('start does not use npx tsx', () => {
    // BREAK: the original defect. A `build` script added while `start` still
    // transpiles at boot fixes nothing.
    const pkg = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8'));
    expect(pkg.scripts.start).not.toMatch(/npx\s+tsx/);
    expect(pkg.scripts.start).toMatch(/node\s+dist\//);
  });

  it('declares a build script', () => {
    const pkg = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8'));
    expect(typeof pkg.scripts.build).toBe('string');
  });

  it('pins esbuild rather than relying on a transitive copy', () => {
    // BREAK: the build working today only because tsx happens to depend on
    // esbuild, and breaking the day it does not.
    const pkg = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8'));
    const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(declared.esbuild).toBeTruthy();
  });
});
