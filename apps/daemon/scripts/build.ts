import { cpSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DB_MIGRATIONS_DIR } from '@10db/db';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'dist');
rmSync(outDir, { recursive: true, force: true });

await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(outDir, 'daemon.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  sourcemap: true,
  // Native addon: loaded from node_modules at runtime; the sidecar packaging step ships it.
  external: ['better-sqlite3'],
  // CommonJS dependencies inside an ESM bundle call require().
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
cpSync(DB_MIGRATIONS_DIR, resolve(outDir, 'drizzle'), { recursive: true });
console.log('Built apps/daemon/dist/daemon.mjs');
