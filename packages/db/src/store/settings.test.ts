import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteAppSetting, getAppSetting, setAppSetting } from './settings';
import { createTestStore } from './test-support';
import type { Store } from './store';

let store: Store;
let close: () => void;

beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

describe('app settings', () => {
  it('is absent until set, round-trips JSON, overwrites and deletes', () => {
    expect(getAppSetting(store.db, 'k')).toBeUndefined();
    store.write((ctx) => {
      setAppSetting(ctx, 'k', { until: '2026-01-01T00:00:00.000Z', n: [1, null, true] });
    });
    expect(getAppSetting(store.db, 'k')).toEqual({
      until: '2026-01-01T00:00:00.000Z',
      n: [1, null, true],
    });
    store.write((ctx) => {
      setAppSetting(ctx, 'k', 'next');
    });
    expect(getAppSetting(store.db, 'k')).toBe('next');
    store.write((ctx) => {
      deleteAppSetting(ctx, 'k');
    });
    expect(getAppSetting(store.db, 'k')).toBeUndefined();
  });
});
