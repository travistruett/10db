import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const SOURCE_DIR = resolve(import.meta.dirname, '..');
const OWN_NAMES = ['SKILL.md', 'README.md', 'tendb.mjs', 'VERSION'] as const;

/**
 * The skill's version: the first twelve hex digits of a SHA-256 over each file's path and bytes, taken in
 * path order so the order the files are listed in never matters.
 */
export function skillDigest(files: readonly { path: string; bytes: Uint8Array }[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path).update('\0').update(file.bytes).update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * Writes the skill into `outDir`: `tendb.mjs` (the CLI bundled for plain node), `SKILL.md`, `README.md` and a
 * `VERSION` that digests those three. Only those four names are removed and rewritten; anything else in
 * `outDir` stays.
 */
export async function buildAgentSkill(outDir: string): Promise<{ version: string }> {
  for (const name of OWN_NAMES) rmSync(join(outDir, name), { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // The skill runs on the builder's own node (22 or later), not the app's.
  await build({
    entryPoints: [join(SOURCE_DIR, 'src/main.ts')],
    outfile: join(outDir, 'tendb.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    banner: { js: '#!/usr/bin/env node' },
  });
  for (const name of ['SKILL.md', 'README.md']) {
    copyFileSync(join(SOURCE_DIR, 'skill', name), join(outDir, name));
  }
  const version = skillDigest(
    (['SKILL.md', 'README.md', 'tendb.mjs'] as const).map((path) => ({
      path,
      bytes: readFileSync(join(outDir, path)),
    })),
  );
  writeFileSync(join(outDir, 'VERSION'), `${version}\n`);
  return { version };
}
