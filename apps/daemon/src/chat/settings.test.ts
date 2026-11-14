import { createTestStore } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { sessionsSettings, setSessionsSettings } from './settings';

// UI spec §5.7: Settings › Sessions on a real SQLite file. A missing value reads as on.

let close: () => void;
afterEach(() => {
  close();
});

describe('Settings › Sessions', () => {
  it('reads on with nothing stored, and keeps what is set', () => {
    const test = createTestStore();
    close = test.close;
    const state = createStateStore(test.store, createEventBus());
    expect(sessionsSettings(state.db)).toEqual({ notifyReplies: true });
    expect(setSessionsSettings(state, { notifyReplies: false })).toEqual({ notifyReplies: false });
    expect(sessionsSettings(state.db)).toEqual({ notifyReplies: false });
  });
});
