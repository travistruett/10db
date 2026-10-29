import { DEFAULT_HAZARDS, type HazardDef } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { hazardHit } from './hazards';

const GIT_ADD: HazardDef = { name: 'staging', globs: [], commands: ['git add', 'git push'] };

interface Row {
  readonly name: string;
  readonly command: string;
  /** The hazard it runs, or null when it runs none. */
  readonly hazard: string | null;
  readonly hazards?: readonly HazardDef[];
}

const ROWS: readonly Row[] = [
  // A flag's value is not the subcommand.
  { name: 'pnpm --filter value', command: 'pnpm --filter x add zod', hazard: 'deps' },
  { name: 'pnpm --reporter value', command: 'pnpm --reporter silent add x', hazard: 'deps' },
  { name: 'pnpm --reporter value named add', command: 'pnpm --reporter add test', hazard: null },
  { name: 'pnpm --filter value named add', command: 'pnpm --filter add test', hazard: null },
  { name: 'pnpm -F value named install', command: 'pnpm -F install test', hazard: null },
  { name: 'pnpm --dir value named add', command: 'pnpm --dir add test', hazard: null },
  { name: 'pnpm --filter=value', command: 'pnpm --filter=x add zod', hazard: 'deps' },
  { name: 'pnpm boolean flags', command: 'pnpm -r --silent add zod', hazard: 'deps' },
  { name: 'npm -p is not a value flag', command: 'npm -p install x', hazard: 'deps' },
  { name: 'npm --prefix value', command: 'npm --prefix web install', hazard: 'deps' },
  { name: 'npm --prefix value named install', command: 'npm --prefix install test', hazard: null },
  { name: 'npm --workspace value', command: 'npm --workspace web i left-pad', hazard: 'deps' },
  { name: 'cargo toolchain', command: 'cargo +stable add serde', hazard: 'deps' },
  { name: 'cargo toolchain, no hazard', command: 'cargo +nightly fmt', hazard: null },
  {
    name: 'cargo --manifest-path value',
    command: 'cargo --manifest-path x/Cargo.toml add serde',
    hazard: 'deps',
  },
  {
    name: 'cargo --manifest-path named add',
    command: 'cargo --manifest-path add test',
    hazard: null,
  },
  { name: 'cargo -p value after the subcommand', command: 'cargo test -p add', hazard: null },
  // An unknown flag in a program with a table may or may not take the next word.
  { name: 'npm unknown flag before install', command: 'npm --frobnicate install', hazard: 'deps' },
  { name: 'pnpm unknown flag before a script', command: 'pnpm --frobnicate test', hazard: null },
  { name: 'pnpm unknown flag before add', command: 'pnpm --frobnicate add x', hazard: 'deps' },
  { name: 'pnpm unknown flag taking add', command: 'pnpm --frobnicate x add zod', hazard: 'deps' },
  {
    name: 'pnpm unknown flag with = before add',
    command: 'pnpm --frobnicate=1 add x',
    hazard: 'deps',
  },
  // Programs without a table keep the flags they always had.
  {
    name: 'make -C value',
    command: 'make -C db migrate',
    hazard: 'schema',
    hazards: [{ name: 'schema', globs: [], commands: ['make migrate'] }],
  },
  // git's global options.
  { name: 'git -C value', command: 'git -C dir add x', hazard: 'staging', hazards: [GIT_ADD] },
  {
    name: 'git -c value',
    command: 'git -c user.name=x push',
    hazard: 'staging',
    hazards: [GIT_ADD],
  },
  {
    name: 'git -C value named add',
    command: 'git -C add status',
    hazard: null,
    hazards: [GIT_ADD],
  },
  { name: 'git --no-pager', command: 'git --no-pager push', hazard: 'staging', hazards: [GIT_ADD] },
  {
    name: 'git --git-dir value',
    command: 'git --git-dir x/.git add y',
    hazard: 'staging',
    hazards: [GIT_ADD],
  },
  // Runners keep reading the program they run.
  {
    name: 'pnpm exec drizzle-kit',
    command: 'pnpm exec drizzle-kit generate',
    hazard: 'migrations',
  },
  {
    name: 'pnpm exec with flags of its own',
    command: 'pnpm -r exec drizzle-kit --config c.ts generate',
    hazard: 'migrations',
  },
  { name: 'npx drizzle-kit', command: 'npx drizzle-kit generate', hazard: 'migrations' },
  // Look-through runners.
  { name: 'mise x --', command: 'mise x -- pnpm add x', hazard: 'deps' },
  { name: 'mise exec --', command: 'mise exec -- pnpm add x', hazard: 'deps' },
  { name: 'mise exec tool --', command: 'mise exec node@22 pnpm@10 -- pnpm add x', hazard: 'deps' },
  { name: 'mise x -- of a safe command', command: 'mise x -- pnpm test', hazard: null },
  { name: 'mise install', command: 'mise install pnpm', hazard: null },
  { name: 'mise exec with no --', command: 'mise exec node@22', hazard: null },
  { name: 'corepack pnpm', command: 'corepack pnpm add x', hazard: 'deps' },
  { name: 'corepack npm', command: 'corepack npm install', hazard: 'deps' },
  { name: 'corepack of a safe command', command: 'corepack pnpm test', hazard: null },
  { name: 'corepack enable', command: 'corepack enable', hazard: null },
  { name: 'arch -arm64', command: 'arch -arm64 pnpm add x', hazard: 'deps' },
  { name: 'arch -x86_64', command: 'arch -x86_64 pnpm add x', hazard: 'deps' },
  { name: 'arch -e value', command: 'arch -arm64 -e FOO=1 pnpm add x', hazard: 'deps' },
  { name: 'arch -arch value', command: 'arch -arch arm64 pnpm add x', hazard: 'deps' },
  { name: 'corepack with a version', command: 'corepack pnpm@9 add x', hazard: 'deps' },
  { name: 'arch of a safe command', command: 'arch -arm64 pnpm test', hazard: null },
  { name: 'script -q /dev/null', command: 'script -q /dev/null pnpm add x', hazard: 'deps' },
  { name: 'script of a safe command', command: 'script -q /dev/null pnpm test', hazard: null },
  { name: 'mise behind env', command: 'env CI=1 mise x -- pnpm add x', hazard: 'deps' },
  { name: 'a runner in a script', command: "bash -c 'corepack pnpm add x'", hazard: 'deps' },
];

describe('hazardHit', () => {
  it.each(ROWS)('$name: $command', ({ command, hazard, hazards }) => {
    expect(hazardHit(command, hazards ?? DEFAULT_HAZARDS)?.name ?? null).toBe(hazard);
  });
});
