import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, type AccountId } from '@10db/contracts';
import { listEventsAfter } from './events';
import {
  listAccountModels,
  markAccountModelUnusable,
  replaceAccountModels,
  type NewAccountModel,
} from './account-models';
import { seedAccount, createTestStore } from './test-support';
import type { Store } from './store';

let store: Store;
let close: () => void;
let accountA: AccountId;
let accountB: AccountId;

beforeEach(() => {
  ({ store, close } = createTestStore());
  accountA = seedAccount(store, { kind: 'claude_subscription', label: 'A' }).id;
  accountB = seedAccount(store, { kind: 'claude_subscription', label: 'B' }).id;
});
afterEach(() => {
  close();
});

const sonnet: NewAccountModel = {
  model: 'sonnet',
  family: 'claude-sonnet',
  launchId: 'claude-sonnet-5',
  efforts: ['low', 'high'],
  inputPrice: 3,
  outputPrice: 15,
};
const gateway: NewAccountModel = {
  model: 'gw-model',
  family: null,
  launchId: 'gw/model',
  efforts: [],
  inputPrice: null,
  outputPrice: null,
};

describe('replaceAccountModels', () => {
  it('replaces the account list rather than appending, and leaves other accounts alone', () => {
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [sonnet, gateway]);
      replaceAccountModels(ctx, accountB, [sonnet]);
    });
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [gateway]);
    });
    expect(listAccountModels(store.db, accountA).map((m) => m.model)).toEqual(['gw-model']);
    expect(listAccountModels(store.db, accountB).map((m) => m.model)).toEqual(['sonnet']);
    expect(listAccountModels(store.db)).toHaveLength(2);
  });

  it('carries family, efforts and the account own prices, null included', () => {
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [sonnet, gateway]);
    });
    expect(listAccountModels(store.db, accountA)).toMatchObject([
      { accountId: accountA, ...gateway, unusable: false },
      { accountId: accountA, ...sonnet, unusable: false },
    ]);
  });

  it('stamps lastSeenAt with the write time', () => {
    const { value } = store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [sonnet]);
      return ctx.now;
    });
    expect(listAccountModels(store.db, accountA)[0]?.lastSeenAt).toBe(value);
  });

  const unusableCases: readonly [string, Partial<NewAccountModel>, boolean][] = [
    ['nothing changed', {}, true],
    ['a price changed', { inputPrice: 4, outputPrice: 20 }, true],
    ['the efforts are reordered', { efforts: ['high', 'low'] }, true],
    ['the launch id changed', { launchId: 'claude-sonnet-5-1' }, false],
    ['an effort was added', { efforts: ['low', 'medium', 'high'] }, false],
    ['an effort was dropped', { efforts: ['low'] }, false],
  ];
  it.each(unusableCases)('with %s, unusable stays %s', (_name, change, stays) => {
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [sonnet]);
      markAccountModelUnusable(ctx, accountA, 'sonnet');
    });
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [{ ...sonnet, ...change }]);
    });
    expect(listAccountModels(store.db, accountA)[0]?.unusable).toBe(stays);
  });

  it('appends an event when the list changes and none when it does not', () => {
    const count = () => listEventsAfter(store.db, 0, 1000).length;
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [sonnet]);
    });
    const afterFirst = count();
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [sonnet]);
    });
    expect(count()).toBe(afterFirst);
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [gateway]);
    });
    expect(count()).toBe(afterFirst + 1);
  });
});

describe('replaceAccountModels input and answer', () => {
  it('refuses a model named twice and leaves the stored list as it was', () => {
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [sonnet]);
    });
    expect(() =>
      store.write((ctx) => {
        replaceAccountModels(ctx, accountA, [gateway, gateway]);
      }),
    ).toThrow(ConflictError);
    expect(listAccountModels(store.db, accountA).map((m) => m.model)).toEqual(['sonnet']);
  });

  it('answers whether the list changed', () => {
    const answers = store.write((ctx) => [
      replaceAccountModels(ctx, accountA, [sonnet]),
      replaceAccountModels(ctx, accountA, [sonnet]),
      replaceAccountModels(ctx, accountA, [gateway]),
    ]).value;
    expect(answers).toEqual([true, false, true]);
  });
});

describe('markAccountModelUnusable', () => {
  it('marks one model of one account', () => {
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [sonnet, gateway]);
      replaceAccountModels(ctx, accountB, [sonnet]);
      markAccountModelUnusable(ctx, accountA, 'sonnet');
    });
    const flags = (id: AccountId) =>
      listAccountModels(store.db, id).map((m) => [m.model, m.unusable]);
    expect(flags(accountA)).toEqual([
      ['gw-model', false],
      ['sonnet', true],
    ]);
    expect(flags(accountB)).toEqual([['sonnet', false]]);
  });

  it('throws NotFoundError for a model the account does not list', () => {
    expect(() =>
      store.write((ctx) => {
        markAccountModelUnusable(ctx, accountA, 'missing');
      }),
    ).toThrow(NotFoundError);
  });
});
