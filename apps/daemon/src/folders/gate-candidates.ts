import { z } from 'zod';

export const GateSource = {
  Makefile: 'makefile',
  PackageJson: 'package_json',
  Cargo: 'cargo',
  Go: 'go',
} as const;
export type GateSource = (typeof GateSource)[keyof typeof GateSource];

/** What a folder holds that names a gate command, already read from disk. */
export interface FolderFiles {
  readonly makefile: string | null;
  /** The parsed JSON of package.json; anything but an object counts as absent. */
  readonly packageJson: unknown;
  /** The lockfile names present in the folder's top level. */
  readonly lockfiles: readonly string[];
  readonly cargoToml: boolean;
  readonly goMod: boolean;
}

export interface GateCandidate {
  readonly command: string;
  readonly source: GateSource;
}

const TARGETS = ['gate', 'check', 'test'] as const;

const PackageJsonSchema = z.looseObject({
  scripts: z.record(z.string(), z.string()).optional(),
  packageManager: z.string().optional(),
});

const NPM_TEST_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

const LOCKFILE_MANAGERS = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
] as const;

function makefileTargets(makefile: string): GateCandidate[] {
  return TARGETS.filter((name) => new RegExp(`^${name}::?(?:\\s|$)`, 'm').test(makefile)).map(
    (name) => ({ command: `make ${name}`, source: GateSource.Makefile }),
  );
}

function packageManagerOf(
  packageManager: string | undefined,
  lockfiles: readonly string[],
): string {
  const named = packageManager?.split('@')[0];
  if (named) return named;
  for (const [lockfile, manager] of LOCKFILE_MANAGERS) {
    if (lockfiles.includes(lockfile)) return manager;
  }
  return 'npm';
}

function packageScripts(packageJson: unknown, lockfiles: readonly string[]): GateCandidate[] {
  const parsed = PackageJsonSchema.safeParse(packageJson);
  if (!parsed.success) return [];
  const scripts = parsed.data.scripts ?? {};
  const manager = packageManagerOf(parsed.data.packageManager, lockfiles);
  const candidates: GateCandidate[] = [];
  for (const name of TARGETS) {
    const body = scripts[name];
    if (body === undefined) continue;
    if (name === 'test' && manager === 'npm' && body.trim() === NPM_TEST_PLACEHOLDER) continue;
    // bun's own `bun test` is a different runner, so bun always goes through `run`.
    const shorthand = name === 'test' && manager !== 'bun';
    candidates.push({
      command: shorthand ? `${manager} test` : `${manager} run ${name}`,
      source: GateSource.PackageJson,
    });
  }
  return candidates;
}

/** Candidate gate commands in the order they are offered; the first is prefilled. */
export function gateCandidates(files: FolderFiles): GateCandidate[] {
  return [
    ...(files.makefile === null ? [] : makefileTargets(files.makefile)),
    ...packageScripts(files.packageJson, files.lockfiles),
    ...(files.cargoToml ? [{ command: 'cargo test', source: GateSource.Cargo }] : []),
    ...(files.goMod ? [{ command: 'go test ./...', source: GateSource.Go }] : []),
  ];
}
