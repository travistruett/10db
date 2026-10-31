import { describe, expect, it } from 'vitest';

import { autoModeRules } from './auto-mode-rules';

describe('autoModeRules', () => {
  it('names the project gate command in the first hard deny', () => {
    const rules = autoModeRules('make gate');
    expect(rules.hard_deny).toHaveLength(3);
    expect(rules.hard_deny[1]).toContain('"make gate"');
    expect(rules.hard_deny[1]).toContain('10db runs');
  });

  it('forbids CPU load as the second hard deny', () => {
    const rules = autoModeRules('make gate');
    expect(rules.hard_deny[2]).toMatch(/busy loops/);
    expect(rules.hard_deny[2]).toMatch(/stress/);
  });

  it('keeps paths outside the worktree as the one soft deny', () => {
    const rules = autoModeRules('make gate');
    expect(rules.soft_deny).toHaveLength(2);
    expect(rules.soft_deny[1]).toMatch(/outside the lane's worktree/);
  });

  it.each([
    ['no gate command', null],
    ['a blank gate command', '   '],
  ])('words the gate rule without a command for %s', (_name, gate) => {
    const rules = autoModeRules(gate);
    expect(rules.hard_deny[1]).toMatch(/full gate/);
    expect(rules.hard_deny[1]).not.toContain('``');
  });

  it.each([
    ['a backtick', 'make `gate`'],
    ['a double quote', 'make "gate"'],
    ['a newline', 'make\ngate'],
    ['a backslash', 'make \\gate'],
  ])('names a gate command with %s without throwing, as one quoted string', (_name, gate) => {
    const rule = autoModeRules(gate).hard_deny[1];
    expect(rule).toContain(JSON.stringify(gate.replaceAll(/\s+/g, ' ')));
    expect(rule).toContain('10db runs it');
  });

  it("keeps Claude Code's built-in rules by naming them first in both lists", () => {
    const rules = autoModeRules('make gate');
    expect(rules.hard_deny[0]).toBe('$defaults');
    expect(rules.soft_deny[0]).toBe('$defaults');
  });
});
