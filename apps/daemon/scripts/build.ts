import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { DB_MIGRATIONS_DIR } from '@10db/db';
import { HARNESS_PLUGIN_DIR } from '@10db/harness';
import { build } from 'esbuild';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(process.argv[2] ?? resolve(root, 'dist'));
// Only the bundle's own outputs are removed: the directory is a CLI argument and may hold other files.
for (const name of [
  'daemon.mjs',
  'daemon.mjs.map',
  'srt.mjs',
  'builder-mcp.mjs',
  'builder-mcp.mjs.map',
  'vendor',
  'drizzle',
  'harness',
  'better_sqlite3.node',
  'build-info.json',
  'release',
  'catalogue-snapshot.json',
]) {
  rmSync(resolve(outDir, name), { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

const bundle = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  // CommonJS dependencies inside an ESM bundle call require().
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
} as const;
await build({
  ...bundle,
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(outDir, 'daemon.mjs'),
  sourcemap: true,
});
// The builder's MCP bridge, which a client runs with the app's node. It needs no database: it only
// forwards calls to the running daemon.
await build({
  ...bundle,
  entryPoints: [resolve(root, 'src/builder-mcp.ts')],
  outfile: resolve(outDir, 'builder-mcp.mjs'),
  sourcemap: true,
});
// srt's command line, which runs every gate under the sandbox: the app carries its own copy.
await build({
  ...bundle,
  entryPoints: [
    createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/dist/cli.js'),
  ],
  outfile: resolve(outDir, 'srt.mjs'),
});
// srt looks for its Java proxy agent beside its own module first. Without it srt runs `npm root -g`,
// outside the sandbox and from the gate's checkout, to find a global copy.
cpSync(
  resolve(
    dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json')),
    'vendor',
    'java-proxy-agent',
    'srt-proxy-agent.jar',
  ),
  resolve(outDir, 'vendor', 'java-proxy-agent', 'srt-proxy-agent.jar'),
);
// The catalogue snapshot a release build fetched (scripts/release/build-macos.sh), if this is one. Any other
// build carries none, so a snapshot from an earlier release build never ships in a later one.
const snapshot = z.string().min(1).optional().parse(process.env['TENDB_CATALOGUE_SNAPSHOT']);
if (snapshot !== undefined) cpSync(snapshot, resolve(outDir, 'catalogue-snapshot.json'));
cpSync(DB_MIGRATIONS_DIR, resolve(outDir, 'drizzle'), { recursive: true });
cpSync(HARNESS_PLUGIN_DIR, resolve(outDir, 'harness'), { recursive: true });
// The scripts the app installs a newer build with (src/self-update), laid out as in the repository
// because they find each other relative to it.
for (const name of ['install-app.sh', 'installed-app.sh']) {
  cpSync(
    resolve(root, '../../scripts/release', name),
    resolve(outDir, 'release', 'scripts', 'release', name),
  );
}
const commit = builtCommit();
if (commit) {
  // The repository is fixed here, from GitHub's own runner, and is the only one the app updates
  // from. A build with none (a local one) shows its commit and never updates itself.
  const repository = builtRepository();
  writeFileSync(
    resolve(outDir, 'build-info.json'),
    `${JSON.stringify(repository ? { commit, repository } : { commit })}\n`,
  );
} else {
  console.warn('No commit found for this build: the app will show none and never update itself.');
}
cpSync(sqliteAddonPath(), resolve(outDir, 'better_sqlite3.node'));
console.log(`Built ${outDir}/daemon.mjs, builder-mcp.mjs and srt.mjs`);

/** The `owner/name` repository GitHub's runner built this for (`GITHUB_REPOSITORY`), else null. */
function builtRepository(): string | null {
  const repository = process.env['GITHUB_REPOSITORY'];
  return repository && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(repository)
    ? repository
    : null;
}

/**
 * The commit this bundle is built from: the one GitHub's runner checked out (`GITHUB_SHA`), else the
 * checkout's own head. Null when neither names a full SHA, as in a source tree with no git.
 */
function builtCommit(): string | null {
  const full = /^[0-9a-f]{40}$/;
  const fromGitHub = process.env['GITHUB_SHA'];
  if (fromGitHub && full.test(fromGitHub)) return fromGitHub;
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return full.test(head) ? head : null;
  } catch {
    return null;
  }
}

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
