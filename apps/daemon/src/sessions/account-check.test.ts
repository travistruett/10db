import { Provider } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { checkAccount, seenFrom } from './account-check';

describe('an OpenRouter account check', () => {
  const expectation = {
    accountId: 'acc_1',
    label: 'Router',
    kind: 'openrouter',
    harness: Provider.Codex,
    identity: null,
  } as const;
  const seen = (requiresOpenaiAuth: boolean | undefined, apiProvider?: string) => ({
    ...seenFrom({ ...(apiProvider === undefined ? {} : { apiProvider }) }),
    requiresOpenaiAuth,
  });

  it('accepts only a Codex that reports no account and no OpenAI sign-in required', () => {
    expect(checkAccount(expectation, seen(false))).toBeNull();
    for (const wrong of [
      seen(true),
      seen(undefined),
      seen(false, 'chatgpt'),
      seen(false, 'apiKey'),
    ])
      expect(checkAccount(expectation, wrong)).toMatchObject({ problem: 'wrong_credentials' });
  });
});
