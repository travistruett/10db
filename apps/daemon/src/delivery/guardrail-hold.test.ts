import { describe, expect, it } from 'vitest';
import { holdAction } from './guardrail-hold';

// Value: protects=a pull request touching a guardrail path is held unless the builder merged that exact
// diff; fails_when=an unreadable diff, a different diff or a missing approval lets a pull request through;
// why_new=permissions and git merges (the shipper's hold); no_claim=the wiring, which ship.test.ts runs.
describe('holdAction', () => {
  it('lets a pull request with no guardrail change through whatever else is known', () => {
    expect(holdAction({ hits: 0, diffHash: null, approved: null })).toBe('none');
    expect(holdAction({ hits: 0, diffHash: 'a', approved: 'b' })).toBe('none');
  });

  it('holds a diff that could not be read, even when something was approved', () => {
    expect(holdAction({ hits: null, diffHash: null, approved: 'a' })).toBe('hold');
    expect(holdAction({ hits: null, diffHash: 'a', approved: 'a' })).toBe('hold');
    expect(holdAction({ hits: 1, diffHash: null, approved: 'a' })).toBe('hold');
  });

  it('approves only the exact diff the builder merged', () => {
    expect(holdAction({ hits: 2, diffHash: 'a', approved: 'a' })).toBe('approved');
    expect(holdAction({ hits: 2, diffHash: 'a', approved: 'b' })).toBe('hold');
    expect(holdAction({ hits: 2, diffHash: 'a', approved: null })).toBe('hold');
  });
});
