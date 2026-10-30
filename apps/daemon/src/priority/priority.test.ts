import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { atPriority } from './index';

describe('atPriority', () => {
  it('runs lane work in the background on macOS, taskpolicy exec-ing the program', () => {
    expect(atPriority('lane', '/bin/claude', ['-p', 'x'], 'darwin')).toEqual({
      file: '/usr/sbin/taskpolicy',
      args: ['-b', '/bin/claude', '-p', 'x'],
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
    // A gate's clamp is allowed inside a sandbox; a lane's background policy is not, so only the gate
    // is run for real here (the lane's wrapper has the same shape and is checked above).
    const launch = atPriority('gate', '/bin/sh', ['-c', 'echo hi; exit 3']);
    const run = spawnSync(launch.file, [...launch.args], { encoding: 'utf8' });
    expect(run.stdout).toBe('hi\n');
    expect(run.status).toBe(3);
  });
});
