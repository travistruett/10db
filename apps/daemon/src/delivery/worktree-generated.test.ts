import { describe, expect, it } from 'vitest';
import { GENERATED, generateCommand, makesDir } from './worktree-generated';

const ENV =
  'pnpm_config_manage_package_manager_versions=false COREPACK_ENABLE_STRICT=0 COREPACK_ENABLE_AUTO_PIN=0';

describe('generateCommand', () => {
  it("runs each generated directory's package's generate script, contracts first, with the given pnpm", () => {
    const command = generateCommand("/opt/it's/pnpm", GENERATED.map((g) => g.dir).reverse());
    const lines = command.split(' && ');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(
      "'/opt/it'\\''s/pnpm' --filter '@10db/contracts' --fail-if-no-match generate",
    );
    expect(lines[1]).toContain(
      "'/opt/it'\\''s/pnpm' --filter '@10db/db' --fail-if-no-match generate",
    );
  });

  it('runs only the generators of the directories asked for, and fails when pnpm finds no such package', () => {
    expect(generateCommand('/usr/bin/pnpm', ['packages/db/drizzle/'])).toBe(
      `${ENV} '/usr/bin/pnpm' --filter '@10db/db' --fail-if-no-match generate`,
    );
  });

  it('names the two directories the root AGENTS.md says are never merged by hand', () => {
    expect(GENERATED.map((g) => g.dir)).toEqual([
      'packages/contracts/generated/',
      'packages/db/drizzle/',
    ]);
  });
});

describe('makesDir', () => {
  const contracts = {
    dir: 'packages/contracts/generated/',
    manifest: 'packages/contracts/package.json',
    name: '@10db/contracts',
  };
  const manifest = (fields: Record<string, unknown>): string => JSON.stringify(fields);

  it('is true for the package that makes the directory with its generate script', () => {
    expect(
      makesDir(
        contracts,
        manifest({ name: '@10db/contracts', scripts: { generate: 'tsx scripts/generate.ts' } }),
      ),
    ).toBe(true);
  });

  it.each([
    ['no package.json', null],
    ['another package', manifest({ name: '@acme/contracts', scripts: { generate: 'x' } })],
    ['no generate script', manifest({ name: '@10db/contracts', scripts: { build: 'x' } })],
    [
      'a generate script that is not a command',
      manifest({ name: '@10db/contracts', scripts: { generate: 1 } }),
    ],
    ['no scripts', manifest({ name: '@10db/contracts' })],
    ['JSON that is not an object', '["@10db/contracts"]'],
    ['text that is not JSON', '{ name: @10db/contracts'],
  ])('is false for %s', (_case, text) => {
    expect(makesDir(contracts, text)).toBe(false);
  });
});
