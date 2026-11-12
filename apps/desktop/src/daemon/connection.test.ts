import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConnection } from './connection';
import { handOffTo } from '@10db/contracts';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: a dev UI tab opened by Open Page
// takes the daemon's connection from its fragment, keeps it for the tab and drops it from the address.

const HANDED = { url: 'http://127.0.0.1:4317', token: 'handed-token' };

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("leaves a dev server's own token first over a hand-off the tab kept from before", async () => {
    window.history.replaceState(
      null,
      '',
      handOffTo(`${window.location.origin}/factory`, window.location.origin, HANDED),
    );
    await resolveConnection();
    vi.stubEnv('VITE_DAEMON_URL', 'http://127.0.0.1:4999');
    vi.stubEnv('VITE_DAEMON_TOKEN', 'own-token');
    expect(await resolveConnection()).toEqual({ url: 'http://127.0.0.1:4999', token: 'own-token' });
  });
});
