import { spawnSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const DB_PACKAGE = join(import.meta.dirname, '../../../packages/db');

export const DRIZZLE_CONFIG = `import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
});
`;

/**
 * Runs the repository's real `drizzle-kit generate` in `dir`, a package with a `drizzle.config.ts`,
 * and answers what it printed. The package borrows the database package's `node_modules`, through a
 * link git must ignore. A schema it can't load exits 0 with the error on stderr, so stderr fails too.
 */
export function drizzleGenerate(dir: string, name: string, custom = false): string {
  const modules = join(dir, 'node_modules');
  if (!existsSync(modules)) symlinkSync(join(DB_PACKAGE, 'node_modules'), modules);
  const run = spawnSync(
    join(DB_PACKAGE, 'node_modules/.bin/drizzle-kit'),
    ['generate', ...(custom ? ['--custom'] : []), '--name', name],
    { cwd: dir, encoding: 'utf8' },
  );
  if (run.status !== 0 || run.stderr.includes('Error'))
    throw new Error(`drizzle-kit failed (${String(run.status)}): ${run.stderr}`);
  return run.stdout;
}
