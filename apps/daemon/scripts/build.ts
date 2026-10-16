import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { DB_MIGRATIONS_DIR } from '@10db/db';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(process.argv[2] ?? resolve(root, 'dist'));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(outDir, 'daemon.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  sourcemap: true,
  // CommonJS dependencies inside an ESM bundle call require().
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
cpSync(DB_MIGRATIONS_DIR, resolve(outDir, 'drizzle'), { recursive: true });
cpSync(sqliteAddonPath(), resolve(outDir, 'better_sqlite3.node'));
console.log(`Built ${outDir}/daemon.mjs`);

/** better-sqlite3 ships one prebuilt addon per platform; @10db/db owns the dependency. */
function sqliteAddonPath(): string {
  const dbRequire = createRequire(resolve(dirname(DB_MIGRATIONS_DIR), 'package.json'));
  const packageDir = dirname(dbRequire.resolve('better-sqlite3/package.json'));
  // process.report's header is untyped; glibcVersionRuntime is absent on musl Linux.
  const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
    .header;
  const musl = process.platform === 'linux' && !header?.glibcVersionRuntime;
  return resolve(
    packageDir,
    'prebuilds',
    `${musl ? 'linuxmusl' : process.platform}-${process.arch}.node`,
  );
}
