import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { acquireInstanceLock, AlreadyRunningError } from './index';

let dir: { path: string; cleanup(): void };
beforeEach(() => {
  dir = tempDir('lock');
});
afterEach(() => {
  dir.cleanup();
});

describe('acquireInstanceLock', () => {
  it('refuses a second holder while the first is alive', () => {
    writeFileSync(join(dir.path, 'daemon.lock'), String(process.ppid));
    expect(() => acquireInstanceLock(dir.path)).toThrow(AlreadyRunningError);
  });

  it('takes over a lock left by a dead process', () => {
    writeFileSync(join(dir.path, 'daemon.lock'), '999999');
    const lock = acquireInstanceLock(dir.path);
    lock.release();
    expect(() => {
      acquireInstanceLock(dir.path).release();
    }).not.toThrow();
  });
});
