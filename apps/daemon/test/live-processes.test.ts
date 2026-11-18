import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stopChild } from '../scripts/live-processes';

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
});
