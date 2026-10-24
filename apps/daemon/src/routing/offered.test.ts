import { describe, expect, it } from 'vitest';
import { offeredProfiles } from './index';
import { testCatalogue } from './test-catalogue';

describe('offeredProfiles', () => {
  it('keeps every profile when the account lists no aliases, and only its aliases when it does', () => {
    const all = testCatalogue();
    expect(offeredProfiles(all, undefined)).toEqual(all);
    const offered = offeredProfiles(all, ['mid']);
    expect(offered.length).toBeGreaterThan(0);
    expect(new Set(offered.map((p) => p.model))).toEqual(new Set(['mid']));
  });
});
