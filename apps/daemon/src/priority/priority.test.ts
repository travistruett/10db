import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { atPriority } from './index';

describe('atPriority', () => {
  it('runs lane work clamped to utility and niced on macOS, below a gate, never in the background', () => {
    // Background QoS (taskpolicy -b) also throttles disk and network, and slowed a lane's Claude Code
    // start past the daemon's 15 s wait for its account (decisions/2026-10-30-lanes-at-utility-priority.md).
    expect(atPriority('lane', '/bin/claude', ['-p', 'x'], 'darwin')).toEqual({
      file: '/usr/bin/nice',
      args: ['-n', '10', '/usr/sbin/taskpolicy', '-c', 'utility', '/bin/claude', '-p', 'x'],
    });
  });

  it('runs a gate clamped to utility on macOS: above lane work, below the builder’s apps', () => {
    expect(atPriority('gate', '/usr/bin/node', ['srt.mjs'], 'darwin')).toEqual({
      file: '/usr/sbin/taskpolicy',
      args: ['-c', 'utility', '/usr/bin/node', 'srt.mjs'],
    });
  });

  it('falls back to nice elsewhere, with a gate less nice than a lane', () => {
    expect(atPriority('lane', 'claude', ['a'], 'linux')).toEqual({
      file: '/usr/bin/nice',
      args: ['-n', '19', 'claude', 'a'],
    });
    expect(atPriority('gate', 'node', [], 'linux')).toEqual({
      file: '/usr/bin/nice',
      args: ['-n', '10', 'node'],
    });
  });

  it('runs the program itself, so a gate wrapped for real still prints and exits as it does', () => {
    for (const tier of ['gate', 'lane'] as const) {
      const launch = atPriority(tier, '/bin/sh', ['-c', 'echo hi; exit 3']);
      const run = spawnSync(launch.file, [...launch.args], { encoding: 'utf8' });
      expect(run.stdout).toBe('hi\n');
      expect(run.status).toBe(3);
    }
  });
});
