import {
  createTestStore,
  insertTask,
  insertWorkstream,
  listSkipsForWorkstream,
  seedProject,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { silentLogger } from '../log';
import { createSkipRecorder, type RecordedSkip } from './skip-recorder';

// T4 Task 4: one recorder per run writes each skip once and says whether the turn's last call, in
// the order the calls were made, was skipped, whichever channel reported the skip and when.

let close: () => void = () => undefined;
afterEach(() => {
  close();
});

function recorder() {
  const test = createTestStore();
  close = test.close;
  const state = createStateStore(test.store, createEventBus());
  const project = seedProject(test.store);
  const task = test.store.write((ctx) =>
    insertTask(ctx, project.id, {
      title: 'Alpha',
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    }),
  ).value;
  const ws = test.store.write((ctx) =>
    insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  ).value;
  const skips = createSkipRecorder(
    { state, log: silentLogger },
    { workstreamId: ws.id, sessionId: null },
  );
  return { skips, listed: () => listSkipsForWorkstream(test.store.db, ws.id) };
}

const skip = (toolUseId: string, over: Partial<RecordedSkip> = {}): RecordedSkip => ({
  toolName: 'WebFetch',
  toolUseId,
  callKey: 'k',
  summary: 'https://example.com',
  kind: 'web_or_mcp',
  limit: 'sends_data_out',
  reason: 'the web',
  source: 'guard',
  ...over,
});

describe('the skip recorder', () => {
  it('records through the store and counts the turn', () => {
    const { skips, listed } = recorder();
    skips.seen('a');
    skips.record(skip('a'));
    expect(listed()).toHaveLength(1);
    expect(skips.inTurn()).toEqual({
      lastCallSkipped: true,
      last: { limit: 'sends_data_out', reason: 'the web' },
      skips: 1,
    });
  });

  it('an allowed call seen after a skip clears lastCallSkipped', () => {
    const { skips } = recorder();
    skips.seen('a');
    skips.record(skip('a'));
    skips.seen('b');
    expect(skips.inTurn().lastCallSkipped).toBe(false);
    expect(skips.inTurn().skips).toBe(1);
  });

  it('a denial recorded after the next call was seen does not make it the last', () => {
    const { skips } = recorder();
    skips.seen('a');
    skips.seen('b');
    skips.record(skip('a', { source: 'auto_mode', kind: 'classifier' }));
    expect(skips.inTurn().lastCallSkipped).toBe(false);
  });

  it('a question doesn’t count', () => {
    const { skips, listed } = recorder();
    skips.seen('q');
    skips.record(
      skip('q', { kind: 'question', source: 'question', limit: null, toolName: 'AskUserQuestion' }),
    );
    expect(listed()).toHaveLength(1);
    expect(skips.inTurn()).toEqual({ lastCallSkipped: false, last: null, skips: 0 });
  });

  it('nextTurn starts a new count', () => {
    const { skips } = recorder();
    skips.seen('a');
    skips.record(skip('a'));
    skips.nextTurn();
    expect(skips.inTurn()).toEqual({ lastCallSkipped: false, last: null, skips: 0 });
  });
});
