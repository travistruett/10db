import { describe, expect, it } from 'vitest';
import { GENERATED, GENERATED_DIRS, generateCommand } from './worktree-generated';

describe('generateCommand', () => {
  it("runs each generated directory's package's generate script, contracts first, with the given pnpm", () => {
    const command = generateCommand("/opt/it's/pnpm", [...GENERATED_DIRS].reverse());
    const lines = command.split(' && ');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("'/opt/it'\\''s/pnpm' --filter '@10db/contracts' generate");
    expect(lines[1]).toContain("'/opt/it'\\''s/pnpm' --filter '@10db/db' generate");
  });

  it('runs only the generators of the directories asked for', () => {
    expect(generateCommand('/usr/bin/pnpm', ['packages/db/drizzle/'])).toBe(
      "pnpm_config_manage_package_manager_versions=false COREPACK_ENABLE_STRICT=0 COREPACK_ENABLE_AUTO_PIN=0 '/usr/bin/pnpm' --filter '@10db/db' generate",
    );
  });

  it('names the two directories the root AGENTS.md says are never merged by hand', () => {
    expect(GENERATED.map((g) => g.dir)).toEqual([
      'packages/contracts/generated/',
      'packages/db/drizzle/',
    ]);
  });
});
