import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from './fixtures';

const DAEMON_DIR = resolve(import.meta.dirname, '..');

/** The exit code the desktop shell's supervisor stops on instead of restarting into the refusal. */
const EXIT_REFUSED_CONFIG = 4;

let data: TempDir;
let elsewhere: TempDir;
beforeEach(() => {
  data = tempDir('refused-config');
  elsewhere = tempDir('refused-config-elsewhere');
  writeFileSync(join(data.path, 'book.json'), '{}');
});
afterEach(() => {
  data.cleanup();
  elsewhere.cleanup();
});

/** Runs the daemon from source with `extraEnv` until it exits; resolves with its code and stderr. */
function run(extraEnv: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: DAEMON_DIR,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      // The test's own temp dir: a sandboxed run can write no other.
      TMPDIR: tmpdir(),
      // The child's git must not read the contributor's own config, which a sandbox can't read.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      TENDB_DATA_DIR: data.path,
      TENDB_PORT: '0',
      TENDB_LOG_LEVEL: 'warn',
      TENDB_FAKE_SCRIPTS: join(data.path, 'book.json'),
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolveRun, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolveRun({ code, stderr });
    });
  });
}

describe('a worktree root the daemon refuses', () => {
  it.each<{ name: string; root: () => string }>([
    { name: 'a relative path', root: () => 'worktrees' },
    { name: 'a place under the data directory', root: () => join(data.path, 'worktrees') },
    {
      name: 'a place under a file',
      root: () => {
        const file = join(elsewhere.path, 'a-file');
        mkdirSync(elsewhere.path, { recursive: true });
        writeFileSync(file, '');
        return join(file, 'worktrees');
      },
    },
  ])('stops startup with one line naming TENDB_WORKTREE_ROOT for $name', async ({ root }) => {
    const { code, stderr } = await run({ TENDB_WORKTREE_ROOT: root() });
    expect(code).toBe(EXIT_REFUSED_CONFIG);
    const lines = stderr.split('\n').filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('TENDB_WORKTREE_ROOT');
  });
});
