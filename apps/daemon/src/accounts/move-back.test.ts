import {
  createTestStore,
  getProject,
  seedAccount,
  seedProject,
  setMoveBack,
  patchProject,
  latestEventSeq,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock, type Timer } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService } from '../inbox';
import { createAccountPauses, createMoveBack, type MoveBack } from './index';

/** Refuses a delay Node would silently turn into 1 ms. */
class StrictClock extends ManualClock {
  override setTimeout(fn: () => void, ms: number): Timer {
    if (ms > 2 ** 31 - 1) throw new Error(`a timer of ${String(ms)} ms overflows`);
    return super.setTimeout(fn, ms);
  }
}

let store: Store;
let close: () => void;
let state: StateStore;
let clock: StrictClock;
let moveBack: MoveBack;

beforeEach(() => {
  clock = new StrictClock(new Date(2026, 9, 20, 12));
  ({ store, close } = createTestStore(() => clock.now()));
  state = createStateStore(store, createEventBus());
  const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  const pauses = createAccountPauses({
    state,
    clock,
    inbox,
    stopAccount: () => Promise.resolve(),
    onResume: () => undefined,
  });
  moveBack = createMoveBack({ state, clock, inbox, pauses, defaultPauseMs: 30 * 60_000 });
});
afterEach(() => {
  moveBack.stop();
  close();
});

describe('a move back whose limit resets far ahead', () => {
  it('waits in timer steps Node accepts, and writes nothing while it waits', () => {
    const project = seedProject(store);
    const from = project.accountId;
    const to = seedAccount(store, { kind: 'claude_subscription', label: 'Second plan' });
    const at = new Date(clock.now().getTime() + 30 * 24 * 60 * 60_000);
    state.write((ctx) => {
      patchProject(ctx, project.id, { accountId: to.id });
      setMoveBack(ctx, project.id, { accountId: from, at: at.toISOString() });
    });
    const before = latestEventSeq(state.db);
    moveBack.arm(project.id);
    moveBack.restore();
    clock.advance(2 ** 31 - 1);
    expect(latestEventSeq(state.db)).toBe(before);
    expect(getProject(state.db, project.id).movedFromAccountId).toBe(from);
  });
});
