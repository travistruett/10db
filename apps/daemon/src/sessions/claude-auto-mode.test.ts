import { TRUST_DEFAULTS } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { buildTrustPolicy } from '../trust';
import { renderClaudeAutoMode } from './claude-auto-mode';

const policyOf = (surface: 'lane' | 'pass' | 'plan', liveSystems: readonly string[] = []) =>
  buildTrustPolicy({
    surface,
    projectName: 'demo',
    checkout: '/w/demo',
    gateCommand: 'make gate',
    liveSystems,
    switches: TRUST_DEFAULTS,
  });

describe('renderClaudeAutoMode', () => {
  it('puts $defaults first in all four lists', () => {
    for (const surface of ['lane', 'pass', 'plan'] as const) {
      const settings = renderClaudeAutoMode(policyOf(surface));
      for (const list of [
        settings.environment,
        settings.allow,
        settings.soft_deny,
        settings.hard_deny,
      ])
        expect(list[0]).toBe('$defaults');
    }
  });

  it('a pass renders the limits as soft denies and the coordination lines as hard denies, label first', () => {
    const settings = renderClaudeAutoMode(policyOf('pass'));
    expect(settings.soft_deny).toEqual([
      '$defaults',
      expect.stringMatching(/^Destroying Data It Didn't Create: Dropping/),
      expect.stringMatching(/^Sending Data Out: /),
      expect.stringMatching(/^Reading Secrets: /),
      expect.stringMatching(/^Writing To Live Systems: /),
    ]);
    expect(settings.hard_deny).toEqual([
      '$defaults',
      expect.stringMatching(
        /^10db Runs The Gate: Running the project's full gate, the command "make gate"/,
      ),
      expect.stringMatching(/^10db Commits And Pushes: /),
      expect.stringMatching(/^Shared Mac: /),
    ]);
  });

  it('a lane renders the limits and the coordination lines as hard denies, and no soft deny past $defaults', () => {
    const settings = renderClaudeAutoMode(policyOf('lane'));
    expect(settings.soft_deny).toEqual(['$defaults']);
    expect(settings.hard_deny).toHaveLength(1 + 4 + 3);
    expect(settings.hard_deny[1]).toMatch(/^Destroying Data It Didn't Create: /);
    expect(settings.hard_deny[5]).toMatch(/^10db Runs The Gate: /);
  });

  it('a Plan policy has no hard denies past $defaults and its limits soft', () => {
    const settings = renderClaudeAutoMode(policyOf('plan'));
    expect(settings.hard_deny).toEqual(['$defaults']);
    expect(settings.soft_deny).toHaveLength(5);
  });

  it('a lane policy with live systems carries them in the environment', () => {
    const settings = renderClaudeAutoMode(policyOf('lane', ['api.example.com']));
    expect(settings.environment.at(-1)).toBe(
      'Sensitive remote targets: "api.example.com". These are live: treat a write to any of them as writing to a live system.',
    );
  });

  it.each(['lane', 'pass', 'plan'] as const)(
    'a %s policy has the classifier judge every shell command, allow rules or not',
    (surface) => {
      expect(renderClaudeAutoMode(policyOf(surface)).classifyAllShell).toBe(true);
    },
  );
});
