import { createTestStore } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { capacitySettings, setCapacitySettings } from './capacity';

let close: () => void;
afterEach(() => {
  close();
});

describe('Settings › This Mac › Capacity', () => {
  it('reads four lanes and a 20 GB floor with nothing stored, and keeps what is set', () => {
    const test = createTestStore();
    close = test.close;
    const state = createStateStore(test.store, createEventBus());
    expect(capacitySettings(state.db)).toEqual({ machineLaneCap: 4, diskFloorGb: 20 });
    expect(setCapacitySettings(state, { machineLaneCap: 3, diskFloorGb: 40 })).toEqual({
      machineLaneCap: 3,
      diskFloorGb: 40,
    });
    expect(capacitySettings(state.db)).toEqual({ machineLaneCap: 3, diskFloorGb: 40 });
  });
});
