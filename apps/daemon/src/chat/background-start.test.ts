import { describe, expect, it } from 'vitest';
import { startsBackground } from './background-start';

const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  toolName: 'Bash',
  input: { command, ...extra },
});

describe('startsBackground', () => {
  it.each([
    ['sleep 5 &', true],
    ['nohup ./job.sh', true],
    ['env FOO=1 nohup ./job.sh', true],
    ['/usr/bin/nohup ./job.sh', true],
    ['time setsid ./job.sh', true],
    ['tmux new -d ./job.sh', true],
    ['screen -dm ./job.sh', true],
    ['launchctl load job.plist', true],
    ['ls -la', false],
    ['pnpm test 2>&1', false],
    ['git status && echo done', false],
  ])('%s → %s', (command, expected) => {
    expect(startsBackground(bash(command))).toBe(expected);
  });

  it('reads Claude Code’s own background flag', () => {
    expect(startsBackground(bash('pnpm dev', { run_in_background: true }))).toBe(true);
  });
});
