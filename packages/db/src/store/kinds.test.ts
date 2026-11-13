import {
  ConflictError,
  InvalidError,
  NotFoundError,
  Rigor,
  mintId,
  type TaskKind,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkTaskKinds,
  deleteKind,
  effectiveRigorOf,
  insertKind,
  listKinds,
  moveKind,
  patchKind,
} from './kinds';
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

const add = (key: string, rest: Record<string, unknown> = {}) =>
  store.write((ctx) => insertKind(ctx, { key, label: key, ...rest })).value;

describe('kinds', () => {
  it('lists kinds in the order they were added and keeps every field', () => {
    add('security', {
      minimumRigor: Rigor.Careful,
      alwaysReviewed: true,
      failsAtLimit: true,
      toInbox: true,
      addsSteps: ['plan_review'],
      overrides: { review: { model: { kind: 'tier', tier: 'frontier' }, effort: 'high' } },
    });
    add('docs');
    const kinds = listKinds(store.db);
    expect(kinds.map((k) => [k.key, k.position])).toEqual([
      ['security', 0],
      ['docs', 1],
    ]);
    expect(kinds[0]).toMatchObject({
      minimumRigor: 'careful',
      alwaysReviewed: true,
      failsAtLimit: true,
      ownCopy: false,
      toInbox: true,
      addsSteps: ['plan_review'],
      overrides: { review: { model: { kind: 'tier', tier: 'frontier' }, effort: 'high' } },
    });
    expect(kinds[1]).toMatchObject({ minimumRigor: null, addsSteps: [], overrides: {} });
  });

  it('refuses a key another kind has', () => {
    add('ui');
    expect(() => add('ui')).toThrow(ConflictError);
  });

  it('patches fields, never the key, and says so for a kind that is gone', () => {
    const kind = add('infra');
    const patched = store.write((ctx) =>
      patchKind(ctx, kind.id, { label: 'Infrastructure', minimumRigor: Rigor.Careful }),
    ).value;
    expect(patched).toMatchObject({
      key: 'infra',
      label: 'Infrastructure',
      minimumRigor: 'careful',
    });
    expect(() =>
      store.write((ctx) => patchKind(ctx, kind.id, { key: 'other' } as never)),
    ).toThrow();
    expect(() => store.write((ctx) => patchKind(ctx, mintId('Kind'), { label: 'x' }))).toThrow(
      NotFoundError,
    );
  });

  it('deletes a kind and moves one, renumbering the rest', () => {
    const a = add('a');
    add('b');
    const c = add('c');
    store.write((ctx) => moveKind(ctx, c.id, 0));
    expect(listKinds(store.db).map((k) => [k.key, k.position])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
    store.write((ctx) => moveKind(ctx, c.id, 99));
    expect(listKinds(store.db).map((k) => k.key)).toEqual(['a', 'b', 'c']);
    store.write((ctx) => {
      deleteKind(ctx, a.id);
    });
    expect(listKinds(store.db).map((k) => k.key)).toEqual(['b', 'c']);
    expect(() =>
      store.write((ctx) => {
        deleteKind(ctx, a.id);
      }),
    ).toThrow(NotFoundError);
  });

  it('refuses a task kind no kind has and keeps the first of a key given twice', () => {
    add('security');
    const given: TaskKind[] = [
      { key: 'security', source: 'builder' },
      { key: 'security', source: 'agent' },
    ];
    expect(checkTaskKinds(store.db, given)).toEqual([{ key: 'security', source: 'builder' }]);
    expect(() => checkTaskKinds(store.db, [{ key: 'nope', source: 'agent' }])).toThrow(
      InvalidError,
    );
  });
});

describe('effectiveRigorOf', () => {
  it('reads the kinds from the database: a kind raises a default below its minimum', () => {
    add('security', { minimumRigor: Rigor.Careful });
    const kinds: TaskKind[] = [{ key: 'security', source: 'agent' }];
    expect(effectiveRigorOf(store.db, 'light', null, kinds)).toBe('careful');
    expect(effectiveRigorOf(store.db, 'light', null, [])).toBe('light');
  });
});
