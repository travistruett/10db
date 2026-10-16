import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Absolute path of the repository root. */
export const repoRoot = resolve(import.meta.dirname, '../../..');

const DependencyMap = z.record(z.string(), z.string());

/** The subset of package.json the repo checks read. */
export const Manifest = z.object({
  name: z.string(),
  version: z.string().optional(),
  private: z.boolean().optional(),
  type: z.literal('module').optional(),
  dependencies: DependencyMap.optional(),
  devDependencies: DependencyMap.optional(),
  optionalDependencies: DependencyMap.optional(),
  engines: z.object({ node: z.string() }).optional(),
  packageManager: z.string().optional(),
});
export type Manifest = z.infer<typeof Manifest>;

/** Repo-relative paths of the root manifest and every workspace manifest. */
export function manifestPaths(): string[] {
  return globSync(
    ['package.json', 'apps/*/package.json', 'packages/*/package.json', 'tests/*/package.json'],
    {
      cwd: repoRoot,
    },
  ).sort();
}

export function readManifest(path: string): Manifest {
  return Manifest.parse(JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')));
}

export function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}
