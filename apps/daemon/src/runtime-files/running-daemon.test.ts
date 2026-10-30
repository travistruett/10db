import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { defaultDataDir, readUiToken, runningDaemon, writeRuntimeFiles } from './index';

let dir: TempDir;
beforeEach(() => {
  dir = tempDir('running-daemon');
});
afterEach(() => {
  dir.cleanup();
});

const info = (pid: number) => ({
  pid,
  port: 4317,
  protocolVersion: 1,
  startedAt: '2026-10-29T10:00:00.000Z',
});

/** A pid that belonged to a process that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  if (child.pid === 0) throw new Error('no child pid');
  return child.pid;
}

describe('runningDaemon', () => {
  it('answers null with no daemon.json', () => {
    expect(runningDaemon(dir.path)).toBeNull();
  });

  it('answers null for a data dir that does not exist', () => {
    expect(runningDaemon(join(dir.path, 'missing'))).toBeNull();
  });

  it.each([
    { name: 'not JSON', text: 'nope' },
    { name: 'JSON of the wrong shape', text: '{"pid":"x"}' },
    { name: 'empty', text: '' },
  ])('answers null for a daemon.json that is $name', ({ text }) => {
    writeFileSync(join(dir.path, 'daemon.json'), text);
    writeFileSync(join(dir.path, 'ui-token'), 'token');
    expect(runningDaemon(dir.path)).toBeNull();
  });

  it('answers the info and token of a live daemon', () => {
    writeRuntimeFiles(dir.path, info(process.pid), 'secret-token');
    expect(runningDaemon(dir.path)).toEqual({ info: info(process.pid), token: 'secret-token' });
  });

  it('answers null for a pid that has exited, without reading the token', () => {
    writeRuntimeFiles(dir.path, info(deadPid()), 'secret-token');
    const readToken = vi.fn(readUiToken);
    expect(runningDaemon(dir.path, readToken)).toBeNull();
    expect(readToken).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'pid', next: { ...info(process.pid), pid: 1 } },
    { name: 'startedAt', next: { ...info(process.pid), startedAt: '2026-10-29T11:00:00.000Z' } },
  ])('answers null when daemon.json names another $name after the token is read', ({ next }) => {
    writeRuntimeFiles(dir.path, info(process.pid), 'old-token');
    const readToken = (dataDir: string): string => {
      writeRuntimeFiles(dataDir, next, 'new-token');
      return readUiToken(dataDir);
    };
    expect(runningDaemon(dir.path, readToken)).toBeNull();
  });

  it('answers null when daemon.json is gone after the token is read', () => {
    writeRuntimeFiles(dir.path, info(process.pid), 'old-token');
    const readToken = (dataDir: string): string => {
      rmSync(join(dataDir, 'daemon.json'));
      return readUiToken(dataDir);
    };
    expect(runningDaemon(dir.path, readToken)).toBeNull();
  });

  it('answers null for a live daemon whose token is missing', () => {
    writeRuntimeFiles(dir.path, info(process.pid), 'secret-token');
    rmSync(join(dir.path, 'ui-token'));
    expect(runningDaemon(dir.path)).toBeNull();
  });
});

describe('writeRuntimeFiles', () => {
  it('removes the old daemon.json before it writes the token', () => {
    // A crashed daemon leaves daemon.json behind. A reader that sees the new token must never see
    // that file beside it, so it goes first; a token write that fails shows the order.
    writeRuntimeFiles(dir.path, info(process.pid), 'old-token');
    mkdirSync(join(dir.path, `ui-token.${String(process.pid)}.tmp`));
    expect(() => {
      writeRuntimeFiles(dir.path, info(process.pid), 'new-token');
    }).toThrow();
    expect(existsSync(join(dir.path, 'daemon.json'))).toBe(false);
  });
});

describe('readUiToken', () => {
  it('reads the token without a trailing newline', () => {
    writeFileSync(join(dir.path, 'ui-token'), 'abc\n');
    expect(readUiToken(dir.path)).toBe('abc');
  });
});

describe('defaultDataDir', () => {
  it('is the app’s Application Support folder', () => {
    expect(defaultDataDir()).toBe(join(homedir(), 'Library', 'Application Support', '10db'));
  });
});
