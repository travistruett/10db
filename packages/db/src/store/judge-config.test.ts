import { DEFAULT_JUDGE_CONFIG } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getJudgeConfig, patchJudgeConfig } from './judge-config';
import { setAppSetting } from './settings';
import type { Store } from './store';
import { createTestStore } from './test-support';

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
      decisions: { review_size: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.9 } },
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
});
