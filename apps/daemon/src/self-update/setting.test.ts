import { createTestStore } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { selfUpdateSetting, setSelfUpdateChoice } from './setting';

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
