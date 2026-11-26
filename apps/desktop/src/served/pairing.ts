import { DevicePlatform, PairResponse, type PairRequest } from '@10db/contracts';
import {
  createAnonymousDaemonClient,
  createDaemonClient,
  DaemonRequestError,
  readJson,
} from '../daemon/client';
import { readDevice, saveDevice } from './device-session';

let taken: { readonly code: string | null } | null = null;

/**
 * The code in the address's fragment (`#code=…`), or null. The address is cleaned on the first read, so the code
 * never stays in the history; later reads (a second render pass) give the same answer.
 */
export function takeCodeFromAddress(): string | null {
  if (taken === null) {
    taken = { code: new URLSearchParams(window.location.hash.replace(/^#/, '')).get('code') };
    window.history.replaceState(window.history.state, '', window.location.pathname);
  }
  return taken.code;
}

/** What this browser is, for the Mac's list of devices. */
export function thisPlatform(): { readonly platform: DevicePlatform; readonly label: string } {
  const agent = navigator.userAgent;
  if (/android/i.test(agent)) return { platform: DevicePlatform.Android, label: 'Android phone' };
  if (/iphone|ipad/i.test(agent)) return { platform: DevicePlatform.Ios, label: 'iPhone' };
  if (/macintosh/i.test(agent)) return { platform: DevicePlatform.Macos, label: 'Mac' };
  return { platform: DevicePlatform.Other, label: 'This device' };
}

/** Pairs with the Mac that served this page and keeps the token; returns the Mac's name. */
export async function pairWithThisHost(input: PairRequest): Promise<string> {
  const old = readDevice();
  const client = createAnonymousDaemonClient(window.location.origin);
  const paired = await readJson(await client.devices.pair.$post({ json: input }), PairResponse);
  saveDevice({ deviceId: paired.deviceId, token: paired.token, host: paired.host.name });
  // Only once the new pairing holds does the old device go, so a wrong code never costs a working one, and it
  // doesn't stay in the Mac's list.
  if (old !== null) {
    await createDaemonClient({ url: window.location.origin, token: old.token })
      .devices.me.$delete()
      .catch(() => undefined);
  }
  return paired.host.name;
}

/** What the pair page tells the builder when pairing failed, never a status number. */
export function pairingFailureText(error: unknown): string {
  if (error instanceof DaemonRequestError) {
    if (error.status === 401) return "That code didn't work. Make a new one on your Mac.";
    if (error.status === 429) return 'Too many tries. Wait a minute, then try again.';
  }
  return "This phone can't reach your Mac. Check that Tailscale is on.";
}
