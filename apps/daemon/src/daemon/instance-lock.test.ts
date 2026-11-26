import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SANDBOXED, tempDir } from '../../test/fixtures';
import { acquireInstanceLock, AlreadyRunningError } from './index';

let dir: { path: string; cleanup(): void };
let holder: ChildProcess | null = null;
beforeEach(() => {
  dir = tempDir('lock');
});
afterEach(() => {
  holder?.kill('SIGKILL');
  holder = null;
  dir.cleanup();
});

/** A loopback port nothing listens on: one that was bound, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (address === null || typeof address === 'string') throw new Error('no port was bound');
  return address.port;
}

describe('acquireInstanceLock', () => {
  it('refuses a second holder while the first is alive', async () => {
    writeFileSync(join(dir.path, 'daemon.lock'), String(process.ppid));
    await expect(acquireInstanceLock(dir.path)).rejects.toThrow(AlreadyRunningError);
  });

  it('takes over a lock left by a dead process', async () => {
    writeFileSync(join(dir.path, 'daemon.lock'), '999999');
    const lock = await acquireInstanceLock(dir.path);
    lock.release();
    const again = await acquireInstanceLock(dir.path);
    again.release();
  });

  // `/bin/ps` is setuid and does not run under the sandbox, so the lock can't identify the holder there.
  it.skipIf(SANDBOXED)(
    'kills and replaces a holder that no longer answers /health',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
        stdio: 'ignore',
      });
      holder = child;
      await once(child, 'spawn');
      const killedBy = new Promise<NodeJS.Signals | null>((resolve) => {
        child.once('exit', (_code, signal) => {
          resolve(signal);
        });
      });
      writeFileSync(join(dir.path, 'daemon.lock'), String(child.pid));
      writeFileSync(
        join(dir.path, 'daemon.json'),
        JSON.stringify({
          pid: child.pid,
          port: await closedPort(),
          protocolVersion: 1,
          startedAt: new Date().toISOString(),
        }),
      );

      const lock = await acquireInstanceLock(dir.path, { silenceMs: 0 });

      expect(readFileSync(join(dir.path, 'daemon.lock'), 'utf8')).toBe(String(process.pid));
      expect(await killedBy).toBe('SIGKILL');
      lock.release();
    },
    20_000,
  );
});
