#!/usr/bin/env node
// Runs ESLint once per workspace package and once for everything outside the packages, so the
// heap follows the largest package instead of the whole repository. Every run happens even after
// a failure; the exit code is non-zero when any run failed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const workspaceParents = ['apps', 'packages', 'tests'];

const packageDirs = workspaceParents.flatMap((parent) =>
  existsSync(join(root, parent))
    ? readdirSync(join(root, parent), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, parent, e.name, 'package.json')))
        .map((e) => `${parent}/${e.name}`)
        .sort()
    : [],
);

const runs = [
  ...packageDirs.map((dir) => ({ name: dir, args: [dir] })),
  {
    name: 'root files',
    args: ['.', ...packageDirs.flatMap((dir) => ['--ignore-pattern', `${dir}/**`])],
  },
];

const failed = [];
for (const run of runs) {
  const started = Date.now();
  const result = spawnSync(
    'pnpm',
    ['exec', 'eslint', '--max-warnings=0', ...process.argv.slice(2), ...run.args],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=5120' },
    },
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  const ok = result.status === 0;
  console.error(`lint ${run.name}: ${ok ? 'ok' : 'FAILED'} (${seconds}s)`);
  if (!ok) failed.push(run.name);
}

if (failed.length > 0) {
  console.error(`lint failed in: ${failed.join(', ')}`);
  process.exit(1);
}
