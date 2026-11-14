import {
  createTestStore,
  deleteKind,
  getAppSetting,
  insertKind,
  listKinds,
  patchKind,
  setAppSetting,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { seedTeam } from './seed';
import { KINDS_IMPLIED_SEEDED_KEY } from './seed-kinds';

let state: StateStore;
let close: () => void;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
});
afterEach(() => {
  close();
});

const seed = () => {
  seedTeam(state, readDefaultPersonas());
};

describe('seedTeam’s kinds', () => {
  it('offers the eight kinds in order, with the minimums, switches and overrides of the design', () => {
    seed();
    const kinds = listKinds(state.db);
    expect(kinds.map((k) => [k.key, k.minimumRigor])).toEqual([
      ['security', 'careful'],
      ['auth', 'careful'],
      ['migration', 'careful'],
      ['dependency', 'standard'],
      ['schema', 'careful'],
      ['infra', 'careful'],
      ['ui', null],
      ['docs', null],
    ]);
    const byKey = new Map(kinds.map((k) => [k.key, k]));
    expect(
      kinds.map((k) => [k.key, k.alwaysReviewed, k.failsAtLimit, k.ownCopy, k.toInbox]),
    ).toEqual([
      ['security', true, true, false, true],
      ['auth', true, true, false, true],
      ['migration', true, false, true, true],
      ['dependency', true, false, true, true],
      ['schema', false, false, false, false],
      ['infra', false, false, false, false],
      ['ui', false, false, false, false],
      ['docs', false, false, false, false],
    ]);
    const review = { personaId: null, model: { kind: 'tier', tier: 'frontier' }, effort: 'high' };
    expect(byKey.get('security')?.overrides).toEqual({
      plan: { personaId: null, model: { kind: 'tier', tier: 'capable' }, effort: 'high' },
      implement: {
        personaId: null,
        model: { kind: 'top_of_tier', tier: 'capable' },
        effort: 'high',
      },
      review,
    });
    expect(byKey.get('auth')?.overrides).toEqual(byKey.get('security')?.overrides);
    expect(byKey.get('migration')?.addsSteps).toEqual(['plan_review']);
    expect(byKey.get('migration')?.overrides).toEqual({
      ...byKey.get('security')?.overrides,
      plan_review: review,
    });
    expect(byKey.get('security')?.addsSteps).toEqual([]);
    expect(kinds.map((k) => [k.key, k.impliedBy, k.skills])).toEqual([
      ['security', [], []],
      ['auth', [], []],
      ['migration', ['migrations'], []],
      ['dependency', ['deps'], []],
      ['schema', [], []],
      ['infra', [], []],
      ['ui', [], []],
      ['docs', [], []],
    ]);
    expect(getAppSetting(state.db, KINDS_IMPLIED_SEEDED_KEY)).toBe(true);
  });

  it('gives the kinds an install seeded before implied-by the hazards that imply them, once', () => {
    seed();
    const migration = () => listKinds(state.db).find((k) => k.key === 'migration');
    const dependency = () => listKinds(state.db).find((k) => k.key === 'dependency');
    // What an install from before the field holds: both kinds seeded, neither implied by anything, and the
    // dependency kind already given an implied-by of the builder's own.
    state.write((ctx) => {
      patchKind(ctx, migration()?.id ?? never(), { impliedBy: [] });
      patchKind(ctx, dependency()?.id ?? never(), { impliedBy: ['packages'] });
      setAppSetting(ctx, KINDS_IMPLIED_SEEDED_KEY, false);
    });
    seed();
    expect(migration()?.impliedBy).toEqual(['migrations']);
    expect(dependency()?.impliedBy).toEqual(['packages']);

    state.write((ctx) => patchKind(ctx, migration()?.id ?? never(), { impliedBy: [] }));
    seed();
    expect(migration()?.impliedBy).toEqual([]);
  });

  it('adds nothing the second time, and does not undo a kind the builder deleted or edited', () => {
    seed();
    const [security, auth] = listKinds(state.db);
    state.write((ctx) => {
      deleteKind(ctx, security?.id ?? never());
      patchKind(ctx, auth?.id ?? never(), { label: 'Sign-in', minimumRigor: 'critical' });
    });
    const kept = listKinds(state.db);
    seed();
    expect(listKinds(state.db)).toEqual(kept);
    expect(kept.map((k) => k.key)).not.toContain('security');
    expect(kept.find((k) => k.key === 'auth')).toMatchObject({
      label: 'Sign-in',
      minimumRigor: 'critical',
    });
  });

  it('keeps a kind the builder made before the first start and adds the rest', () => {
    state.write((ctx) => {
      insertKind(ctx, { key: 'docs', label: 'Writing', minimumRigor: 'light' });
    });
    seed();
    const kinds = listKinds(state.db);
    expect(kinds).toHaveLength(8);
    expect(kinds.find((k) => k.key === 'docs')).toMatchObject({
      label: 'Writing',
      minimumRigor: 'light',
    });
  });
});

function never(): never {
  throw new Error('the kind was not seeded');
}
