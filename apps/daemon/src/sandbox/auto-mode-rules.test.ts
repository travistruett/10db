import { describe, expect, it } from 'vitest';

import { autoModeRules, AutoModeRulesError } from './auto-mode-rules';

describe('autoModeRules', () => {
  it('names the project gate command in the first hard deny', () => {
    const rules = autoModeRules('make gate');
    expect(rules.hard_deny).toHaveLength(2);
    expect(rules.hard_deny[0]).toContain('`make gate`');
    expect(rules.hard_deny[0]).toContain('10db runs');
  });

  it('forbids CPU load as the second hard deny', () => {
    const rules = autoModeRules('make gate');
    expect(rules.hard_deny[1]).toMatch(/busy loops/);
    expect(rules.hard_deny[1]).toMatch(/stress/);
  });

  it('keeps paths outside the worktree as the one soft deny', () => {
    const rules = autoModeRules('make gate');
    expect(rules.soft_deny).toHaveLength(1);
    expect(rules.soft_deny[0]).toMatch(/outside the lane's worktree/);
  });

  it.each([
    ['no gate command', null],
    ['a blank gate command', '   '],
  ])('words the gate rule without a command for %s', (_name, gate) => {
    const rules = autoModeRules(gate);
    expect(rules.hard_deny[0]).toMatch(/full gate/);
    expect(rules.hard_deny[0]).not.toContain('``');
  });

  it('refuses a gate command that would break the rule text', () => {
    expect(() => autoModeRules('make `gate`')).toThrow(AutoModeRulesError);
  });
});
