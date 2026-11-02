import { createTestStore, setAppSetting } from '@10db/db';
import { describe, expect, it, vi } from 'vitest';
import { laneAutoMode, setLaneAutoMode } from './lane-auto-mode';

describe('laneAutoMode', () => {
  it('is on until the builder turns it off, and keeps what they set', () => {
    const test = createTestStore();
    expect(laneAutoMode(test.store.db)).toBe(true);
    test.store.write((ctx) => {
      setLaneAutoMode(ctx, false);
    });
    expect(laneAutoMode(test.store.db)).toBe(false);
    test.store.write((ctx) => {
      setLaneAutoMode(ctx, true);
    });
    expect(laneAutoMode(test.store.db)).toBe(true);
    test.close();
  });

  it.each([['"yes"'], [1], [{ on: true }]])(
    'falls back to default mode, with a warning, for the stored value %j',
    (value) => {
      const test = createTestStore();
      test.store.write((ctx) => {
        setAppSetting(ctx, 'lane_auto_mode', value);
      });
      const warn = vi.fn();
      expect(laneAutoMode(test.store.db, warn)).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      test.close();
    },
  );
});
