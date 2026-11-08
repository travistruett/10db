import { AccountKind, ModelMarkBasis, type AccountId } from '@10db/contracts';
import {
  createTestStore,
  listAccountModels,
  replaceAccountModels,
  seedAccount,
  WORDING_MARK_MS,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { clearModelMark, markModelUnusable, resumeModelMarks } from './model-marks';

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let id: AccountId;

const model = (name: string) => ({
  model: name,
  family: null,
  launchId: name,
  efforts: [],
  inputPrice: null,
  outputPrice: null,
});
const row = (name: string) => listAccountModels(store.db, id).find((m) => m.model === name);

beforeEach(() => {
  clock = new ManualClock();
  ({ store, close } = createTestStore(() => clock.now()));
  state = createStateStore(store, createEventBus());
  id = seedAccount(store, { kind: AccountKind.ClaudeSubscription, label: 'sub' }).id;
  state.write((ctx) => replaceAccountModels(ctx, id, [model('a'), model('b')]));
});
afterEach(() => {
  close();
});

describe('markModelUnusable', () => {
  it('ends a mark from wording by itself when its time comes, and keeps a final one', () => {
    markModelUnusable({ state, clock }, id, 'a', ModelMarkBasis.Wording);
    markModelUnusable({ state, clock }, id, 'b', ModelMarkBasis.Error);
    clock.advance(WORDING_MARK_MS - 1);
    expect(row('a')?.unusable).toBe(true);
    clock.advance(1);
    expect(row('a')?.unusable).toBe(false);
    // The ended mark stays on record until a session settles it.
    expect(row('a')?.wordingMarkEndsAt).not.toBeNull();
    expect(row('b')).toMatchObject({ unusable: true, wordingMarkEndsAt: null });
  });

  it('answers null for a model the account does not list', () => {
    expect(markModelUnusable({ state, clock }, id, 'missing', ModelMarkBasis.Wording)).toBeNull();
  });
});

describe('clearModelMark', () => {
  it('clears a mark from wording and leaves a final one', () => {
    markModelUnusable({ state, clock }, id, 'a', ModelMarkBasis.Wording);
    markModelUnusable({ state, clock }, id, 'b', ModelMarkBasis.Error);
    clearModelMark({ state }, id, 'a');
    clearModelMark({ state }, id, 'b');
    expect(row('a')).toMatchObject({ unusable: false, wordingMarkEndsAt: null });
    expect(row('b')?.unusable).toBe(true);
  });
});

describe('resumeModelMarks', () => {
  it('ends the marks that ended while the daemon was down and times the rest, which a restart lost', () => {
    markModelUnusable({ state, clock }, id, 'a', ModelMarkBasis.Wording);
    clock.advance(30 * 60_000);
    markModelUnusable({ state, clock }, id, 'b', ModelMarkBasis.Wording);
    // The daemon restarts with a clock that has no timers, after the first mark ended and before the second.
    clock = new ManualClock(new Date(clock.now().getTime() + WORDING_MARK_MS - 30 * 60_000));
    resumeModelMarks({ state, clock });
    expect(row('a')?.unusable).toBe(false);
    expect(row('b')?.unusable).toBe(true);
    clock.advance(30 * 60_000);
    expect(row('b')?.unusable).toBe(false);
  });
});
