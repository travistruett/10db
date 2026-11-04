import { createTestStore, setAppSetting } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import {
  DEFAULT_WAIT_MINUTES,
  SELF_UPDATE_WAIT_MINUTES_KEY,
  selfUpdateSetting,
  selfUpdateWaitMinutes,
  setSelfUpdateChoice,
  setSelfUpdateWaitMinutes,
} from './setting';

let close: () => void;
let state: StateStore;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
});
afterEach(() => {
  close();
});

describe('the self-update setting', () => {
  it('is on until the builder chooses', () => {
    expect(selfUpdateSetting(state.db)).toEqual({ enabled: true, isDefault: true });
  });

  it('turns off, and on again, as the builder says', () => {
    setSelfUpdateChoice(state, false);
    expect(selfUpdateSetting(state.db)).toEqual({ enabled: false, isDefault: false });
    setSelfUpdateChoice(state, true);
    expect(selfUpdateSetting(state.db)).toEqual({ enabled: true, isDefault: false });
  });

  it('goes back to the default when the choice is forgotten', () => {
    setSelfUpdateChoice(state, false);
    setSelfUpdateChoice(state, null);
    expect(selfUpdateSetting(state.db)).toEqual({ enabled: true, isDefault: true });
  });
});

describe('how long an update waits before it drains the factory', () => {
  it('is 15 minutes until the builder chooses', () => {
    expect(DEFAULT_WAIT_MINUTES).toBe(15);
    expect(selfUpdateWaitMinutes(state.db)).toBe(15);
  });

  it('is what the builder chose, and 0 means drain at once', () => {
    setSelfUpdateWaitMinutes(state, 45);
    expect(selfUpdateWaitMinutes(state.db)).toBe(45);
    setSelfUpdateWaitMinutes(state, 0);
    expect(selfUpdateWaitMinutes(state.db)).toBe(0);
  });

  it('goes back to the default when the choice is forgotten', () => {
    setSelfUpdateWaitMinutes(state, 45);
    setSelfUpdateWaitMinutes(state, null);
    expect(selfUpdateWaitMinutes(state.db)).toBe(15);
  });

  it('ignores a stored value that is not a whole number of minutes', () => {
    state.write((ctx) => {
      setAppSetting(ctx, SELF_UPDATE_WAIT_MINUTES_KEY, 'soon');
    });
    expect(selfUpdateWaitMinutes(state.db)).toBe(15);
  });
});
