import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRuntimeInfo } from '../src/daemon';
import { tempDir, waitForAsync, type TempDir } from './fixtures';

const daemonRoot = resolve(import.meta.dirname, '..');

describe('the bundled daemon', () => {
  let work: TempDir;

  beforeAll(() => {
    work = tempDir('bundle');
    execFileSync('pnpm', ['exec', 'tsx', 'scripts/build.ts', join(work.path, 'dist')], {
      cwd: daemonRoot,
      stdio: 'pipe',
    });
  }, 120_000);
  afterAll(() => {
    work.cleanup();
  });

  it('runs from a directory with no node_modules anywhere above it', async () => {
    // The sidecar's resources directory has no node_modules, so the bundle must carry everything.
    const appDir = join(work.path, 'app');
    cpSync(join(work.path, 'dist'), appDir, { recursive: true });
    expect(existsSync(join(appDir, 'better_sqlite3.node'))).toBe(true);
    const dataDir = join(work.path, '10db data');
    let stderr = '';
    const child = spawn(process.execPath, [join(appDir, 'daemon.mjs')], {
      cwd: work.path,
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: work.path,
        SHELL: '/bin/sh',
        TENDB_DATA_DIR: dataDir,
        TENDB_PORT: '0',
        TENDB_LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((done) => {
      child.once('exit', (code) => {
        done(code);
      });
    });
    try {
      const info = await waitForAsync(() => {
        if (child.exitCode !== null) throw new Error(`the bundle exited early:\n${stderr}`);
        if (!existsSync(join(dataDir, 'daemon.json'))) return Promise.resolve(undefined);
        // readRuntimeInfo parses the file with the daemon's own schema.
        const parsed = readRuntimeInfo(dataDir);
        return Promise.resolve(parsed.pid === child.pid ? parsed : undefined);
      }, 30_000);
      const res = await fetch(`http://127.0.0.1:${String(info.port)}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok' });
    } finally {
      child.kill('SIGTERM');
    }
    expect(await exited).toBe(0);
  }, 60_000);

  it('writes only its own outputs into an existing directory', () => {
    const out = join(work.path, 'shared');
    mkdirSync(join(out, 'drizzle'), { recursive: true });
    writeFileSync(join(out, '.env'), 'KEEP=1\n');
    writeFileSync(join(out, 'drizzle', 'stale.sql'), 'stale');
    execFileSync('pnpm', ['exec', 'tsx', 'scripts/build.ts', out], {
      cwd: daemonRoot,
      stdio: 'pipe',
    });
    expect(existsSync(join(out, '.env'))).toBe(true);
    expect(existsSync(join(out, 'daemon.mjs'))).toBe(true);
    expect(existsSync(join(out, 'better_sqlite3.node'))).toBe(true);
    expect(existsSync(join(out, 'drizzle', 'meta', '_journal.json'))).toBe(true);
    expect(existsSync(join(out, 'drizzle', 'stale.sql'))).toBe(false);
  }, 120_000);
});
