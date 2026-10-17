import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, waitForAsync, type TempDir } from './fixtures';

const DAEMON_DIR = resolve(import.meta.dirname, '..');

let data: TempDir;
let child: ChildProcess | null = null;

beforeEach(() => {
  data = tempDir('parent-death');
  writeFileSync(join(data.path, 'book.json'), '{}');
});
afterEach(() => {
  child?.kill('SIGKILL');
  child = null;
  data.cleanup();
});

function launch(extraEnv: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: DAEMON_DIR,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      TENDB_DATA_DIR: data.path,
      TENDB_PORT: '0',
      TENDB_LOG_LEVEL: 'warn',
      TENDB_FAKE_SCRIPTS: join(data.path, 'book.json'),
      ...extraEnv,
    },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

async function listening(): Promise<void> {
  await waitForAsync(
    () => Promise.resolve(existsSync(join(data.path, 'daemon.json')) || undefined),
    20_000,
  );
}

describe('parent death through stdin', () => {
  it('shuts down cleanly when stdin closes and TENDB_PARENT_STDIN is 1', async () => {
    child = launch({ TENDB_PARENT_STDIN: '1' });
    const exited = new Promise<number | null>((resolveExit) => child?.once('exit', resolveExit));
    await listening();
    child.stdin?.end();
    expect(await exited).toBe(0);
    expect(existsSync(join(data.path, 'daemon.json'))).toBe(false);
  });

  it('ignores a closed stdin without the variable', async () => {
    child = launch({});
    let exitCode: number | null | undefined;
    child.once('exit', (code) => {
      exitCode = code;
    });
    await listening();
    child.stdin?.end();
    // Give an unwanted shutdown time to show; the check below is on a settled state, not a sleep.
    await waitForAsync(async () => {
      await new Promise((r) => setImmediate(r));
      return existsSync(join(data.path, 'ui-token')) ? true : undefined;
    });
    expect(exitCode).toBeUndefined();
    expect(existsSync(join(data.path, 'daemon.json'))).toBe(true);
  });
});
