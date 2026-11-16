import { setAppSetting, createTestStore } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionsSettingsPatch } from '@10db/contracts';
import { createEventBus, createStateStore } from '../events';
import { patchSessionsSettings, sessionsSettings, setSessionsSettings } from './settings';

// UI spec §5.7: Settings › Sessions on a real SQLite file. A missing value reads as on, and the terminal as
// Terminal.

let close: () => void;
afterEach(() => {
  close();
});

function world() {
  const test = createTestStore();
  close = test.close;
  return createStateStore(test.store, createEventBus());
}

describe('Settings › Sessions', () => {
  it('reads the defaults with nothing stored, and keeps what is set', () => {
    const state = world();
    expect(sessionsSettings(state.db)).toEqual({ notifyReplies: true, terminalApp: 'terminal' });
    expect(setSessionsSettings(state, { notifyReplies: false, terminalApp: 'copy' })).toEqual({
      notifyReplies: false,
      terminalApp: 'copy',
    });
    expect(sessionsSettings(state.db)).toEqual({ notifyReplies: false, terminalApp: 'copy' });
  });

  it('a partial change sets its fields and keeps the rest', () => {
    const state = world();
    setSessionsSettings(state, { notifyReplies: false, terminalApp: 'terminal' });
    expect(patchSessionsSettings(state, { terminalApp: 'iterm' })).toEqual({
      notifyReplies: false,
      terminalApp: 'iterm',
    });
    expect(patchSessionsSettings(state, { notifyReplies: true })).toEqual({
      notifyReplies: true,
      terminalApp: 'iterm',
    });
  });

  it('a stored app that is not one of the three reads as Terminal and keeps the rest', () => {
    const state = world();
    state.write((ctx) => {
      setAppSetting(ctx, 'sessions', { notifyReplies: false, terminalApp: 'Terminal; rm -rf ~' });
    });
    expect(sessionsSettings(state.db)).toEqual({ notifyReplies: false, terminalApp: 'terminal' });
  });

  it('refuses a change that is not one of the three apps, or names another field', () => {
    expect(SessionsSettingsPatch.safeParse({ terminalApp: 'Terminal; rm -rf ~' }).success).toBe(
      false,
    );
    expect(SessionsSettingsPatch.safeParse({ terminalApp: 'iterm', extra: 1 }).success).toBe(false);
    expect(SessionsSettingsPatch.safeParse({}).success).toBe(true);
  });
});
