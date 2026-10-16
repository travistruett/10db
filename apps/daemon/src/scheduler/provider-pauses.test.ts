import { createTestStore, getWorkstream, listInbox, transitionWorkstream } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService } from '../inbox';
import { createProviderPauses } from './index';

let close: () => void;
let base: ReturnType<typeof createTestStore>['store'];
let state: StateStore;
let clock: ManualClock;
let stopped: string[];
let resumed: number;

beforeEach(() => {
  const t = createTestStore();
  base = t.store;
  close = t.close;
  state = createStateStore(t.store, createEventBus());
  clock = new ManualClock();
  stopped = [];
  resumed = 0;
});
afterEach(() => {
  close();
});

function pauses() {
  return createProviderPauses({
    state,
    clock,
    inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
    stopProvider: (p) => {
      stopped.push(p);
      return Promise.resolve();
    },
    onResume: () => {
      resumed += 1;
    },
    defaultPauseMs: 30 * 60_000,
  });
}

describe('provider pauses', () => {
  it('pauses once, raises one notice, and re-queues paused work at the reset', () => {
    const { project, workstream } = seedWorkstream(base);
    state.write((ctx) => {
      transitionWorkstream(ctx, workstream.id, { to: 'STARTING', fence: null });
      transitionWorkstream(ctx, workstream.id, { to: 'PAUSED_LIMIT', fence: null });
    });
    const p = pauses();
    const reset = new Date(clock.now().getTime() + 10 * 60_000);
    p.pause('claude', reset, project.id);
    p.pause('claude', reset, project.id);
    expect(p.isPaused('claude')).toBe(true);
    expect(stopped).toEqual(['claude', 'claude']);
    expect(listInbox(state.db, { states: ['OPEN'] })).toHaveLength(1);

    clock.advance(10 * 60_000);
    expect(p.isPaused('claude')).toBe(false);
    expect(getWorkstream(state.db, workstream.id).state).toBe('QUEUED');
    expect(resumed).toBe(1);
  });

  it('uses the default length when no reset time is known', () => {
    const { project } = seedWorkstream(base);
    const p = pauses();
    p.pause('claude', null, project.id);
    clock.advance(29 * 60_000);
    expect(p.isPaused('claude')).toBe(true);
    clock.advance(2 * 60_000);
    expect(p.isPaused('claude')).toBe(false);
  });

  it('restores a persisted pause after a restart', () => {
    const { project } = seedWorkstream(base);
    pauses().pause('claude', new Date(clock.now().getTime() + 5 * 60_000), project.id);
    const restarted = pauses();
    restarted.restore();
    expect(restarted.isPaused('claude')).toBe(true);
  });
});
