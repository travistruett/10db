import { DEFAULT_JUDGE_CONFIG, InvalidError, mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getJudgeConfig, patchJudgeConfig } from './judge-config';
import { setAppSetting } from './settings';
import type { Store } from './store';
import { archiveAccount } from './accounts';
import { createTestStore, seedAccount } from './test-support';

let store: Store;
let close: () => void;

beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

describe('judge config', () => {
  it('reads as the defaults until set', () => {
    expect(getJudgeConfig(store.db)).toEqual(DEFAULT_JUDGE_CONFIG);
  });

  it.each([
    ['not an object', 'on'],
    [
      'a floor above one',
      { enabled: true, decisions: { review_size: { enabled: true, model: 'm', floor: 3 } } },
    ],
    ['a missing decision', { enabled: false, decisions: {} }],
  ])('reads %s as the defaults', (_name, stored) => {
    store.write((ctx) => {
      setAppSetting(ctx, 'judge', stored);
    });
    expect(getJudgeConfig(store.db)).toEqual(DEFAULT_JUDGE_CONFIG);
  });

  it('merges a patch into what is stored, one field at a time', () => {
    store.write((ctx) => patchJudgeConfig(ctx, { decisions: { review_size: { floor: 0.9 } } }));
    store.write((ctx) => patchJudgeConfig(ctx, { enabled: false }));
    expect(getJudgeConfig(store.db)).toEqual({
      enabled: false,
      accountId: null,
      decisions: {
        ...DEFAULT_JUDGE_CONFIG.decisions,
        review_size: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.9 },
      },
    });
  });

  it('answers the config a patch produced', () => {
    const config = store.write((ctx) =>
      patchJudgeConfig(ctx, {
        decisions: { review_size: { model: 'anthropic/claude-haiku-5.5' } },
      }),
    ).value;
    expect(config.decisions.review_size.model).toBe('anthropic/claude-haiku-5.5');
  });

  describe('the account decisions run on', () => {
    const openRouter = () => seedAccount(store, { kind: 'openrouter', label: 'OpenRouter' });

    it('keeps it when a patch does not name one, and clears it on null', () => {
      const account = openRouter();
      store.write((ctx) => patchJudgeConfig(ctx, { accountId: account.id }));
      store.write((ctx) => patchJudgeConfig(ctx, { enabled: false }));
      expect(getJudgeConfig(store.db).accountId).toBe(account.id);
      store.write((ctx) => patchJudgeConfig(ctx, { accountId: null }));
      expect(getJudgeConfig(store.db).accountId).toBeNull();
    });

    it.each<{ name: string; pick: () => ReturnType<typeof mintId<'Account'>> }>([
      { name: 'unknown', pick: () => mintId('Account') },
      {
        name: 'archived',
        pick: () => {
          const account = openRouter();
          store.write((ctx) => archiveAccount(ctx, account.id));
          return account.id;
        },
      },
      {
        name: 'not an OpenRouter account',
        pick: () => seedAccount(store, { kind: 'anthropic_api_key', label: 'Key' }).id,
      },
    ])('refuses an account that is $name', ({ pick }) => {
      const accountId = pick();
      expect(() => store.write((ctx) => patchJudgeConfig(ctx, { accountId }))).toThrow(
        InvalidError,
      );
      expect(getJudgeConfig(store.db).accountId).toBeNull();
    });
  });
});
