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
});
