import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readRuntimeInfo } from '../src/daemon';
import { tempDir, waitForAsync, type TempDir } from './fixtures';

const daemonRoot = resolve(import.meta.dirname, '..');

/** A worktree root outside every temp dir; the test cuts no worktree, so it is never created. */
const BUNDLE_WORKTREE_ROOT = '/var/empty/10db-bundle-test-worktrees';

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
        // The test's own temp dir: a sandboxed run can write no other.
        TMPDIR: tmpdir(),
        SHELL: '/bin/sh',
        TENDB_DATA_DIR: dataDir,
        // The default root is under HOME, which lies in the temp dir; the daemon refuses a worktree
        // root there when it runs under a sandbox, whose temp root is all a lane can write. This
        // one is outside it, and the test never cuts a worktree, so nothing is created there.
        TENDB_WORKTREE_ROOT: BUNDLE_WORKTREE_ROOT,
        TENDB_PORT: '0',
        TENDB_LOG_LEVEL: 'warn',
        // A throwaway daemon never fetches models.dev.
        TENDB_CATALOGUE: 'off',
        // It never messages a real person.
        TENDB_SLACK: 'off',
        // It still builds its model profiles, from the fixture catalogue.
        TENDB_CATALOGUE_SNAPSHOT: resolve(import.meta.dirname, 'fixtures/catalogue.json'),
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
      // With no credential /health answers only status and protocol; the commit needs the app's token.
      const token = readFileSync(join(dataDir, 'ui-token'), 'utf8').trim();
      const res = await fetch(`http://127.0.0.1:${String(info.port)}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      // The header shows this commit; a bundle outside Applications shows it and never updates itself.
      const built = z
        .object({ commit: z.string() })
        .parse(JSON.parse(readFileSync(join(appDir, 'build-info.json'), 'utf8')));
      expect(await res.json()).toMatchObject({ status: 'ok', commit: built.commit });
    } finally {
      child.kill('SIGTERM');
    }
    expect(await exited).toBe(0);
  }, 60_000);

  it('records the commit it was built from, for the header and for the update check', () => {
    const out = join(work.path, 'stamped');
    const commit = 'ab'.repeat(20);
    execFileSync('pnpm', ['exec', 'tsx', 'scripts/build.ts', out], {
      cwd: daemonRoot,
      stdio: 'pipe',
      env: { ...process.env, GITHUB_SHA: commit, GITHUB_REPOSITORY: '' },
    });
    expect(JSON.parse(readFileSync(join(out, 'build-info.json'), 'utf8'))).toEqual({ commit });
  }, 120_000);
});
