import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

// Ships the pinned Node binary as the Tauri sidecar, plus the daemon bundle as a resource.
const desktop = resolve(import.meta.dirname, '..');
const repo = resolve(desktop, '../..');
const tauri = resolve(desktop, 'src-tauri');

// mise.toml pins Node for the whole repo, so its `node = "x.y.z"` line is the version to ship.
const pinned = /^node = "([^"]+)"$/m.exec(readFileSync(resolve(repo, 'mise.toml'), 'utf8'))?.[1];
if (!pinned) throw new Error('mise.toml has no node = "x.y.z" line');
if (process.version !== `v${pinned}`) {
  throw new Error(
    `Run this with Node ${pinned} (found ${process.version}); the sidecar ships this exact binary.`,
  );
}

const triple = /^host: (\S+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
if (!triple) throw new Error('rustc -vV did not report a host triple');

const resources = resolve(tauri, 'resources', 'daemon');
execFileSync('pnpm', ['--filter', '@10db/daemon', 'exec', 'tsx', 'scripts/build.ts', resources], {
  cwd: repo,
  stdio: 'inherit',
});

const binaries = resolve(tauri, 'binaries');
mkdirSync(binaries, { recursive: true });
const target = resolve(binaries, `tendb-node-${triple}`);
const source = statSync(process.execPath);
// Signing changes the copy's size, so a stamp of the source decides whether to copy again.
const stamp = `${process.version} ${String(source.size)} ${String(source.mtimeMs)}\n`;
const stampPath = resolve(binaries, '.tendb-node.stamp');
if (!existsSync(target) || !existsSync(stampPath) || readFileSync(stampPath, 'utf8') !== stamp) {
  copyFileSync(process.execPath, target);
  chmodSync(target, 0o755);
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'inherit' });
  }
  writeFileSync(stampPath, stamp);
}
console.log(`Sidecar ready: ${target} and ${resources}`);
