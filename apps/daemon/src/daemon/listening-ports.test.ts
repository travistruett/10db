import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listenersFrom, systemListeners } from './listening-ports';

describe('listenersFrom', () => {
  it('pairs each listening address with its process and working directory', () => {
    const listening = [
      'p101',
      'cnode',
      'f23',
      'n127.0.0.1:3000',
      'f24',
      'n[::1]:3000',
      'p202',
      'cnginx',
      'f6',
      'n*:8800',
      'p303',
      'cweird',
      'f1',
      'nnot-an-address',
    ].join('\n');
    const cwds = ['p101', 'fcwd', 'n/Users/me/app/web', 'p202', 'fcwd', 'n/'].join('\n');
    expect(listenersFrom(listening, cwds)).toEqual([
      { port: 3000, host: '127.0.0.1', cwd: '/Users/me/app/web', command: 'node' },
      { port: 3000, host: '[::1]', cwd: '/Users/me/app/web', command: 'node' },
      { port: 8800, host: '*', cwd: '/', command: 'nginx' },
    ]);
  });

  it('gives a process whose directory could not be read no directory', () => {
    expect(listenersFrom('p7\ncx\nf3\nn*:5173\n', '')).toEqual([
      { port: 5173, host: '*', cwd: null, command: 'x' },
    ]);
  });

  it('is empty when nothing listens', () => {
    expect(listenersFrom('', '')).toEqual([]);
  });
});

const started: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A node process listening on a free loopback port from `cwd`; resolves to its port. */
function serverIn(cwd: string): Promise<number> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const s=require('node:http').createServer(()=>{});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
    ],
    { cwd, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  started.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk: Buffer) => {
      resolve(Number(chunk.toString().trim()));
    });
    child.once('error', reject);
  });
}

describe('systemListeners', () => {
  it('finds a listening process by its port and its working directory', async (ctx) => {
    try {
      await systemListeners();
    } catch {
      ctx.skip(
        'lsof cannot run here (CI’s Linux image has none at /usr/sbin, and a sandbox refuses it)',
      );
    }
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'listener-')));
    dirs.push(cwd);
    const port = await serverIn(cwd);
    const found = (await systemListeners()).find((l) => l.port === port);
    expect(found).toMatchObject({ host: '127.0.0.1', cwd, command: 'node' });
  });
});
