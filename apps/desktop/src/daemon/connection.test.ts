import { afterEach, describe, expect, it } from 'vitest';
import { resolveConnection } from './connection';
import { handOffTo } from './dev-ui-handoff';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: a dev UI tab opened by Open Page
// takes the daemon's connection from its fragment, keeps it for the tab and drops it from the address.

const HANDED = { url: 'http://127.0.0.1:4317', token: 'handed-token' };

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('resolveConnection in a dev UI tab', () => {
  it('takes the handed connection, keeps it for the tab, and drops it from the address', async () => {
    window.history.replaceState(
      null,
      '',
      handOffTo(`${window.location.origin}/factory?x=1`, window.location.origin, HANDED),
    );
    expect(await resolveConnection()).toEqual(HANDED);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/factory?x=1');
    // A reload has no fragment: the tab still has its connection.
    expect(await resolveConnection()).toEqual(HANDED);
  });
});
