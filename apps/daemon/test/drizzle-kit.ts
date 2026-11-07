import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const DB_PACKAGE = join(import.meta.dirname, '../../../packages/db');

export const DRIZZLE_CONFIG = `import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
});
`;

/** What one generate wrote, by path under its package, and what it printed. */
interface Generated {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly stdout: string;
}

/** Every generate of this test file, by a hash of all that it reads. */
const generated = new Map<string, Generated>();

/** The files a generate reads and writes, by path under the package. */
function packageFiles(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const path of ['drizzle.config.ts', 'src/schema.ts'])
    files.set(path, readFileSync(join(dir, path)));
  const migrations = join(dir, 'drizzle');
  if (existsSync(migrations))
    for (const entry of readdirSync(migrations, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);
      if (entry.isFile()) files.set(path.slice(dir.length + 1), readFileSync(path));
    }
  return files;
}

function generateKey(files: ReadonlyMap<string, Buffer>, name: string, custom: boolean): string {
  const hash = createHash('sha256').update(JSON.stringify([name, custom]));
  for (const path of [...files.keys()].sort()) {
    hash.update(`\0${path}\0`);
    hash.update(files.get(path) ?? '');
  }
  return hash.digest('hex');
}

/**
 * Runs the repository's real `drizzle-kit generate` in `dir`, a package with a `drizzle.config.ts`,
 * and answers what it printed. The package borrows the database package's `node_modules`, through a
 * link git must ignore. A schema it can't load exits 0 with the error on stderr, so stderr fails too.
 *
 * A generate is a function of what it reads, and a test file makes the same ones again and again at
 * 0.5 to 1 s a process, so each one runs once and later calls write what it wrote. Its random snapshot
 * ids and timestamps are among what the next generate reads, so a chain of them repeats exactly.
 */
export function drizzleGenerate(dir: string, name: string, custom = false): string {
  const modules = join(dir, 'node_modules');
  if (!existsSync(modules)) symlinkSync(join(DB_PACKAGE, 'node_modules'), modules);
  const before = packageFiles(dir);
  const key = generateKey(before, name, custom);
  const known = generated.get(key);
  if (known !== undefined) {
    for (const [path, content] of known.files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return known.stdout;
  }
  const run = spawnSync(
    join(DB_PACKAGE, 'node_modules/.bin/drizzle-kit'),
    ['generate', ...(custom ? ['--custom'] : []), '--name', name],
    { cwd: dir, encoding: 'utf8' },
  );
  if (run.status !== 0 || run.stderr.includes('Error'))
    throw new Error(`drizzle-kit failed (${String(run.status)}): ${run.stderr}`);
  const files = new Map(
    [...packageFiles(dir)].filter(([path, content]) => !before.get(path)?.equals(content)),
  );
  generated.set(key, { files, stdout: run.stdout });
  return run.stdout;
}
