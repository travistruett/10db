import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, type AccountId } from '@10db/contracts';
import { listEventsAfter } from './events';
import {
  clearWordingMark,
  endWordingMarks,
  listAccountModels,
  markAccountModelUnusable,
  replaceAccountModels,
  WORDING_MARK_MS,
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

// A mark from an error's wording alone cannot tell a config error from a real refusal, so it ends on its own and
// one later session settles it. Its own store, with a clock the test moves.
describe('a mark from an error’s wording', () => {
  let clockMs: number;
  const start = Date.parse('2026-11-08T10:00:00.000Z');
  const at = (afterMs: number) => new Date(start + afterMs).toISOString();
  const offer = () => listAccountModels(store.db, accountA)[0];
  /** The time passes; the daemon's timer ends the marks whose time has come. */
  const passTo = (after: number) => {
    clockMs = start + after;
    return store.write((ctx) => endWordingMarks(ctx)).value;
  };

  beforeEach(() => {
    close();
    clockMs = start;
    ({ store, close } = createTestStore(() => new Date(clockMs)));
    accountA = seedAccount(store, { kind: 'claude_subscription', label: 'A' }).id;
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [sonnet]);
    });
  });
  const mark = (basis: 'error' | 'wording', after = 0) => {
    clockMs = start + after;
    return store.write((ctx) => markAccountModelUnusable(ctx, accountA, 'sonnet', basis)).value;
  };

  it('keeps the model out of routing until it ends, then lets it be tried again', () => {
    expect(mark('wording')).toEqual({ endsAt: at(WORDING_MARK_MS), confirmed: false });
    expect(offer()).toMatchObject({ unusable: true, wordingMarkEndsAt: at(WORDING_MARK_MS) });
    expect(passTo(WORDING_MARK_MS - 1)).toBe(at(WORDING_MARK_MS));
    expect(offer()?.unusable).toBe(true);
    // At its end the mark stays on record, so the drawer can say a session is yet to settle it.
    expect(passTo(WORDING_MARK_MS)).toBeNull();
    expect(offer()).toMatchObject({ unusable: false, wordingMarkEndsAt: at(WORDING_MARK_MS) });
  });

  it('becomes final when the model is refused again after the mark ended', () => {
    mark('wording');
    passTo(WORDING_MARK_MS);
    expect(mark('wording', WORDING_MARK_MS + 5)).toEqual({ endsAt: null, confirmed: true });
    expect(offer()).toMatchObject({ unusable: true, wordingMarkEndsAt: null });
    passTo(10 * WORDING_MARK_MS);
    expect(offer()?.unusable).toBe(true);
  });

  it('becomes final when the refusal comes after its end, though its timer has not run yet', () => {
    mark('wording');
    expect(mark('wording', WORDING_MARK_MS + 5)).toEqual({ endsAt: null, confirmed: true });
  });

  it('is not extended by a refusal while it is in force', () => {
    mark('wording');
    expect(mark('wording', 60_000)).toEqual({ endsAt: at(WORDING_MARK_MS), confirmed: false });
  });

  it('is cleared by a session that ran on the model once the mark ended', () => {
    mark('wording');
    passTo(WORDING_MARK_MS);
    expect(store.write((ctx) => clearWordingMark(ctx, accountA, 'sonnet')).value).toBe(true);
    expect(offer()).toMatchObject({ unusable: false, wordingMarkEndsAt: null });
    expect(store.write((ctx) => clearWordingMark(ctx, accountA, 'sonnet')).value).toBe(false);
  });

  it('leaves a mark from model_not_found final, whatever comes after', () => {
    expect(mark('error')).toEqual({ endsAt: null, confirmed: true });
    mark('wording', WORDING_MARK_MS + 5);
    expect(store.write((ctx) => clearWordingMark(ctx, accountA, 'sonnet')).value).toBe(false);
    passTo(10 * WORDING_MARK_MS);
    expect(offer()).toMatchObject({ unusable: true, wordingMarkEndsAt: null });
  });

  it('becomes final when model_not_found follows it', () => {
    mark('wording');
    mark('error', 60_000);
    passTo(10 * WORDING_MARK_MS);
    expect(offer()).toMatchObject({ unusable: true, wordingMarkEndsAt: null });
  });

  it('survives a list refresh while the offer is unchanged, and goes with a changed one', () => {
    mark('wording');
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [{ ...sonnet, inputPrice: 4 }]);
    });
    expect(offer()).toMatchObject({ unusable: true, wordingMarkEndsAt: at(WORDING_MARK_MS) });
    store.write((ctx) => {
      replaceAccountModels(ctx, accountA, [{ ...sonnet, launchId: 'claude-sonnet-5-1' }]);
    });
    expect(offer()).toMatchObject({ unusable: false, wordingMarkEndsAt: null });
  });
});
