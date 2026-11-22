import { describe, expect, it } from 'vitest';
import {
  AccountInput,
  AccountKind,
  harnessOf,
  parseAccountSettings,
  Provider,
  requireHarness,
} from './index';

describe('the harness an account runs', () => {
  it('is the stored one when the kind allows it, else the kind first, and refused outside its list', () => {
    const plan = { kind: AccountKind.ClaudeSubscription, label: 'Plan', settings: {} };
    expect(harnessOf(plan)).toBe(Provider.Claude);
    expect(harnessOf({ ...plan, kind: AccountKind.CodexSignin })).toBe(Provider.Codex);
    expect(
      harnessOf({
        ...plan,
        settings: parseAccountSettings(AccountKind.ClaudeSubscription, { harness: 'claude' }),
      }),
    ).toBe(Provider.Claude);

    // A Claude plan cannot run Codex, in stored settings or in a new account's.
    expect(() =>
      parseAccountSettings(AccountKind.ClaudeSubscription, { harness: Provider.Codex }),
    ).toThrow();
    expect(
      AccountInput.safeParse({
        kind: AccountKind.ClaudeSubscription,
        label: 'Plan',
        settings: { harness: Provider.Codex },
      }).success,
    ).toBe(false);

    // A kind with no harness has none to run and is refused with the launcher's words.
    const openRouter = { kind: AccountKind.OpenRouter, label: 'OpenRouter', settings: {} };
    expect(harnessOf(openRouter)).toBeNull();
    expect(() => requireHarness(openRouter)).toThrow('no harness runs OpenRouter yet');
  });
});
