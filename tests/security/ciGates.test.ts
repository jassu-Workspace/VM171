/**
 * Cycle 3.8 — CI gates.
 * ---------------------------------------------------------------------------
 * 633 tests and a typecheck that gate NOTHING, because there is no CI. A green
 * suite on a laptop is not a guarantee; a red one discovered by a user is.
 *
 * What the workflow must actually enforce, and — more importantly — what it
 * must NOT:
 *
 *   - It must NOT gate on the extension typecheck yet. There are 74 real errors
 *     catalogued there. A gate that is permanently red trains people to ignore
 *     red, which is worse than no gate: it also suppresses the four gates that
 *     DO matter. It runs as an ADVISORY job that reports and continues, and it
 *     is a hard gate the moment the count reaches zero.
 *
 *   - It must NOT depend on secrets. No job may read GEMINI_API_KEY or the
 *     router key, because a fork or a Dependabot PR would then have them.
 *
 * These tests assert the workflow's SHAPE, so a later edit that quietly drops
 * the secret scan — or promotes the advisory typecheck to blocking — fails
 * here rather than in production.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');

function workflow(): string {
  return readFileSync(WORKFLOW, 'utf8');
}

describe('Cycle 3.8 — the workflow exists and runs on every change', () => {
  it('has a CI workflow', () => {
    // BREAK: no automation at all, which is the current state.
    expect(existsSync(WORKFLOW)).toBe(true);
  });

  it('triggers on push and on pull requests', () => {
    // BREAK: running only on push, so a PR is merged without ever being tested.
    const yml = workflow();
    expect(yml).toMatch(/^\s*push:/m);
    expect(yml).toMatch(/^\s*pull_request:/m);
  });

  it('gates the test suites', () => {
    // BREAK: building without testing, which passes while the app is broken.
    const yml = workflow();
    expect(yml).toMatch(/npm (ci|install)/);
    expect(yml).toMatch(/npm test|vitest run/);
  });
});

describe('Cycle 3.8 — the four gates that matter', () => {
  it('scans history for secrets with gitleaks', () => {
    // BREAK: dropping the secret scan. Commit 8dec66fe still contains a live
    // .env with API keys, and this is the job that would say so on every push.
    const yml = workflow();
    expect(yml.toLowerCase()).toContain('gitleaks');
  });

  it('runs the dependency audit at a high threshold', () => {
    const yml = workflow();
    expect(yml).toMatch(/npm audit/);
    expect(yml).toMatch(/--audit-level=high/);
  });

  it('verifies repo hygiene', () => {
    // BREAK: node_modules and .env quietly returning to the index.
    const yml = workflow();
    expect(yml).toContain('verify-repo-hygiene');
  });

  it('asserts the built bundle carries no secret or absolute dev path', () => {
    // BREAK: shipping an artifact containing the Windows build path or a
    // credential, which is exactly what the committed .output did.
    const yml = workflow();
    expect(yml).toContain('verify-bundle');
  });
});

describe('Cycle 3.8 — the typecheck is advisory, not blocking', () => {
  /** The body of a named job, from its 2-space-indented key to the next one. */
  function jobBody(yml: string, name: string): string {
    const start = yml.search(new RegExp(`^  ${name}:`, 'm'));
    if (start === -1) return '';
    const rest = yml.slice(start + 1);
    // A job ends at the next line indented exactly 2 spaces, or at end of file.
    const end = rest.search(/^ {2}[a-zA-Z][a-zA-Z0-9-]*:/m);
    return end === -1 ? rest : rest.slice(0, end);
  }

  it('runs the extension typecheck', () => {
    // BREAK: deleting the job entirely, which would hide the 74-error debt
    // instead of tracking it.
    const yml = workflow();
    expect(yml).toContain('typecheck');
    expect(jobBody(yml, 'typecheck')).toMatch(/npm run typecheck/);
  });

  it('does not let an extension typecheck failure fail the workflow', () => {
    // BREAK: promoting the advisory job to blocking while 74 errors remain.
    // A permanently red gate is worse than none: it teaches people to ignore
    // red, and it masks the gates that do matter.
    //
    // The check is on the JOB's own `continue-on-error`, not on the file text.
    // A substring search over the whole file is satisfied by the word appearing
    // in a comment — which is exactly the false pass this had before.
    const yml = workflow();
    const body = jobBody(yml, 'typecheck');
    expect(body).toMatch(/continue-on-error:\s*true/);
  });

  it('is not a hard dependency of any other job', () => {
    // BREAK: making a blocking job `needs: typecheck`, which reintroduces the
    // permanent red build through the back door even if the job itself is
    // marked advisory.
    const yml = workflow();
    for (const other of ['secrets', 'audit', 'test', 'build', 'server-smoke']) {
      const body = jobBody(yml, other);
      expect(body, `${other} must not depend on typecheck`).not.toMatch(/needs:.*\btypecheck\b/);
    }
  });
});

describe('Cycle 3.8 — no job may read a real credential', () => {
  it('never references a real provider secret', () => {
    // BREAK: a job that injects GEMINI_API_KEY from the repository secret
    // store. A fork or a Dependabot PR would then run with a live key, and
    // `pull_request` is one of our triggers.
    //
    // The property that matters is a REFERENCE to the secret store, not the
    // mere presence of the variable name — a named placeholder is safe, and
    // blocking those would only push someone to pass a real key inline.
    const yml = workflow();
    for (const secret of ['GEMINI_API_KEY', 'ROUTER_API_KEY', 'SECRETS_PAIRING_CODE']) {
      expect(yml, secret).not.toMatch(new RegExp(`secrets\\.${secret}`));
    }
  });

  it('gives the server placeholders rather than plausible credentials', () => {
    // BREAK: a "placeholder" that is actually a real key, committed in plain
    // text. A value that looks live is worse than an obviously fake one,
    // because it survives every review and every secret scan.
    const yml = workflow();
    const assigned = [...yml.matchAll(/^\s*(GEMINI_API_KEY|ROUTER_API_KEY|SECRET_PASSWORD|SECRETS_SIGNING_KEY|SECRETS_PAIRING_CODE):\s*(\S+)/gm)];
    expect(assigned.length).toBeGreaterThan(0);
    for (const [, name, value] of assigned) {
      expect(value, name).toMatch(/^(ci-smoke|\$\{\{)/);
      expect(value, name).not.toMatch(/sk-|AIza|[A-Za-z0-9]{24,}/);
    }
  });

  it('uses placeholder values for anything the server needs to boot', () => {
    // BREAK: a smoke test that boots the server with no SECRET_PASSWORD, which
    // exits(1) by design, and fails for the wrong reason.
    const yml = workflow();
    expect(yml).toMatch(/SECRET_PASSWORD|secrets-signing/);
  });
});
