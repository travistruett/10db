import { createDaemonClient } from '../daemon/client';
import { resolveConnection, type ConnectionResolver } from '../daemon/connection';
import { forgetDevice, isForgetting, readDevice } from './device-session';

export class NotPairedError extends Error {
  override readonly name = 'NotPairedError';
  constructor() {
    super('This device is not paired with a Mac');
  }
}

/**
 * Every call of the phone's connection goes through here. A 401 on a paired device means the Mac removed it
 * (a revoked token is the only way a stored one fails), so the token is dropped and the page loads again to
 * say so, rather than every view showing its own failure.
 */
const watchedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const device = readDevice();
  if (response.status === 401 && device !== null && !isForgetting()) {
    forgetDevice(device.host);
    window.location.reload();
  }
  return response;
};

/**
 * The page's own origin with the stored device token. `/events/head` asks the daemon once whether the token still
 * stands, because `/health` answers a revoked token with the public form and would leave the page connecting for
 * good. A page run by Vite (`pnpm dev`) with no pairing falls back to the dev connection the window's browser
 * mode uses, so the phone's screens can be seen on a laptop against a dev daemon.
 */
export const resolveServedConnection: ConnectionResolver = async () => {
  const device = readDevice();
  if (device === null) {
    if (import.meta.env.DEV) return resolveConnection();
    throw new NotPairedError();
  }
  const connection = { url: window.location.origin, token: device.token, fetch: watchedFetch };
  await createDaemonClient(connection).events.head.$get();
  return connection;
};
