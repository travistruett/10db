import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { envWithoutGitVariables } from './fixtures';
import { readRepoFile, repoRoot } from './workspace';

interface Plan {
  readonly full: boolean;
  readonly reason: string | null;
  readonly changed?: readonly string[];
  readonly affected?: readonly string[];
  readonly outside?: readonly string[];
  readonly typecheck?: readonly string[];
  readonly drift?: readonly string[];
  readonly rust?: boolean;
}

/** What `scripts/check-changed.mjs --plan` says it would run for these changed files. */
function planFor(...files: string[]): Plan {
  const result = spawnSync('node', ['scripts/check-changed.mjs', '--plan', '--', ...files], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: envWithoutGitVariables(),
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Plan;
}

describe('scripts/check-changed.mjs', () => {
  it('checks only the desktop for a desktop change: nothing depends on it', () => {
    const plan = planFor('apps/desktop/src/views/settings/general-values.ts');
    expect(plan).toMatchObject({
      full: false,
      changed: ['apps/desktop'],
      affected: ['apps/desktop'],
      typecheck: ['@10db/desktop'],
      drift: [],
      rust: false,
    });
  });

  it('widens typecheck and tests to every dependent of a changed package', () => {
    const plan = planFor('packages/db/src/schema.ts');
    expect(plan.changed).toEqual(['packages/db']);
    expect(plan.affected).toEqual(['apps/daemon', 'apps/desktop', 'packages/db']);
    expect(plan.drift).toEqual(['@10db/db']);
  });

  it('follows dependents through a package that depends on another', () => {
    const plan = planFor('packages/contracts/src/entities.ts');
    expect(plan.affected).toEqual(
      expect.arrayContaining(['packages/contracts', 'packages/db', 'apps/daemon', 'apps/desktop']),
    );
    expect(plan.drift).toEqual(['@10db/contracts']);
  });

  it('runs the Rust checks for a change in the Tauri shell', () => {
    expect(planFor('apps/desktop/src-tauri/src/main.rs').rust).toBe(true);
  });

  it('adds the repo rule tests for a docs or script change, and no package', () => {
    const plan = planFor('docs/architecture/decisions/README.md', 'scripts/check.sh');
    expect(plan).toMatchObject({
      full: false,
      changed: [],
      outside: ['docs/architecture/decisions/README.md', 'scripts/check.sh'],
      affected: ['tests/repo'],
    });
  });

  it.each([
    ['the lockfile', 'pnpm-lock.yaml'],
    ['the root manifest', 'package.json'],
    ['the lint config', 'eslint.config.js'],
    ['the gate script', 'scripts/gate.sh'],
    ['a CI workflow', '.github/workflows/ci.yml'],
    ['the Makefile', 'Makefile'],
    ['a shared test setup file', 'tests/git-isolation.setup.ts'],
  ])('falls back to the full gate for %s', (_name, file) => {
    const plan = planFor('apps/desktop/src/app.tsx', file);
    expect(plan.full).toBe(true);
    expect(plan.reason).toContain(file);
  });

  it('plans nothing for no changed file', () => {
    expect(planFor()).toMatchObject({ full: false, changed: [], affected: [] });
  });

  it('is what `make check-changed` runs', () => {
    expect(readRepoFile('Makefile')).toMatch(
      /^check-changed:\n\t@node scripts\/check-changed\.mjs$/m,
    );
  });
});
