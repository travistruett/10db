import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './workspace';

// The probes are excluded from the normal lint run; `ignore: false` lints them anyway.
const eslint = new ESLint({ cwd: repoRoot, ignore: false });

async function ruleIdsFor(probe: string): Promise<string[]> {
  const [result] = await eslint.lintFiles([
    resolve(repoRoot, 'tests/repo/fixtures/lint-probes', probe),
  ]);
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'fatal');
}

describe('lint rules fire', () => {
  it('reports floating promises (type-aware rules are on)', async () => {
    expect(await ruleIdsFor('floating-promise.ts')).toContain(
      '@typescript-eslint/no-floating-promises',
    );
  });

  it('reports deep imports into a workspace package', async () => {
    expect(await ruleIdsFor('deep-import.ts')).toContain('no-restricted-imports');
  });
});
