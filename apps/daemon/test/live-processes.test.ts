import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { descendantPids, repoServerEnvKeys, stopChild } from '../scripts/live-processes';

const ready = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    child.stdout?.once('data', () => {
      resolve();
    });
  });

const spawnNode = (code: string): ChildProcess =>
  spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });

describe('stopChild', () => {
  it('ends a child that honours SIGTERM', async () => {
    const child = spawnNode("console.log('up'); setInterval(() => undefined, 1000);");
    await ready(child);
    await stopChild(child, 5_000);
    expect(child.signalCode).toBe('SIGTERM');
  });

  it('kills a child that ignores SIGTERM once the timeout passes', async () => {
    const child = spawnNode(
      "process.on('SIGTERM', () => undefined); console.log('up'); setInterval(() => undefined, 1000);",
    );
    await ready(child);
    await stopChild(child, 200);
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('sends one SIGTERM however many callers stop the child', async () => {
    // Exits cleanly on the first SIGTERM after a delay; a second SIGTERM would end it by signal.
    const child = spawnNode(
      "process.once('SIGTERM', () => { console.log('term'); setTimeout(() => process.exit(0), 300); }); console.log('up'); setInterval(() => undefined, 1000);",
    );
    await ready(child);
    const first = stopChild(child, 5_000);
    await ready(child); // the child has taken its one SIGTERM
    const second = stopChild(child, 5_000);
    await Promise.all([first, second]);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  });

  it('returns at once for a child that already exited', async () => {
    const child = spawnNode('process.exit(3)');
    await new Promise((resolve) => child.once('exit', resolve));
    await stopChild(child, 200);
    expect(child.exitCode).toBe(3);
  });
});

// `ps -axo pid=,ppid=`: 10 is the daemon; 11 its claude; 12 and 13 the server's npm and node; 20 is an
// unrelated Claude Code window with its own copy of the same server (21, 22).
const TREE = `
    1     0
   10     1
   11    10
   12    11
   13    12
   20     1
   21    20
   22    21
`;

describe('descendantPids', () => {
  it('walks parent links down from the daemon and leaves other trees out', () => {
    expect([...descendantPids(TREE, 10)].sort()).toEqual([11, 12, 13]);
    expect([...descendantPids(TREE, 99)]).toEqual([]);
  });
});

describe('repoServerEnvKeys', () => {
  const server = (pid: number, env: string): string =>
    `${String(pid)} node /x/node_modules/.bin/mcp-server ${env}`;
  const listing = [
    '11 claude --print ANTHROPIC_API_KEY=should-not-count',
    server(12, 'HOME=/h PATH=/p npm_command=exec'),
    server(13, 'HOME=/h PATH=/p _=/bin/node'),
    server(21, 'GITHUB_TOKEN=x HOME=/h PATH=/p'),
  ].join('\n');

  it('merges the keys of the daemon-descended server processes only', () => {
    expect(repoServerEnvKeys({ tree: TREE, envListing: listing, daemonPid: 10 })).toEqual([
      'HOME',
      'PATH',
      '_',
      'npm_command',
    ]);
  });

  it('is null until a server process descends from the daemon', () => {
    const others = server(21, 'GITHUB_TOKEN=x HOME=/h PATH=/p');
    expect(repoServerEnvKeys({ tree: TREE, envListing: others, daemonPid: 10 })).toBeNull();
  });
});
