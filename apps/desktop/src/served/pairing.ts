import { DevicePlatform, PairResponse, type PairRequest } from '@10db/contracts';
import { createAnonymousDaemonClient, readJson } from '../daemon/client';
import { saveDevice } from './device-session';

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
  const client = createAnonymousDaemonClient(window.location.origin);
  const paired = await readJson(await client.devices.pair.$post({ json: input }), PairResponse);
  saveDevice({ deviceId: paired.deviceId, token: paired.token, host: paired.host.name });
  return paired.host.name;
}
