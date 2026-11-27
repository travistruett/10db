import { PushKeyDto } from '@10db/contracts';
import { useEffect, useState } from 'react';
import { readJson, type DaemonClient } from '../daemon/client';
import { useDaemon } from '../daemon/provider';

export const PushState = {
  /** Reading what the browser holds. */
  Loading: 'loading',
  /** This browser can't do push (no worker, or no Notification). */
  Unsupported: 'unsupported',
  /** The builder refused notifications in the browser; only its settings can change that. */
  Blocked: 'blocked',
  Off: 'off',
  On: 'on',
} as const;
export type PushState = (typeof PushState)[keyof typeof PushState];

/** The VAPID key is base64url; `subscribe` takes its bytes. */
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(key.length / 4) * 4, '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return null;
  return (await navigator.serviceWorker.getRegistration('/app/')) ?? null;
}

/**
 * Subscribes with the host's key and tells the Mac, which holds the subscription it pushes to. A refusal drops the
 * browser's subscription only when the builder is turning push on; a re-send keeps it, so the next start tries again.
 */
async function subscribeAndKeep(
  reg: ServiceWorkerRegistration,
  client: DaemonClient,
  key: string,
  dropOnRefusal: boolean,
): Promise<void> {
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(key),
  });
  const { endpoint, keys } = subscription.toJSON();
  if (endpoint === undefined || keys?.['p256dh'] === undefined || keys['auth'] === undefined) {
    await subscription.unsubscribe();
    throw new Error('The browser gave no push keys.');
  }
  const kept = await client.devices.me.push.$put({
    json: { endpoint, p256dh: keys['p256dh'], auth: keys['auth'] },
  });
  if (!kept.ok) {
    if (dropOnRefusal) await subscription.unsubscribe();
    throw new Error('The Mac did not keep this phone for notifications.');
  }
}

const sameBytes = (a: ArrayBuffer | null, b: Uint8Array): boolean =>
  a !== null && a.byteLength === b.length && new Uint8Array(a).every((byte, i) => byte === b[i]);

/**
 * The browser may hold a subscription the Mac does not (after Forget or a revoke and a re-pair, a key change, or
 * the push service rotating it). When there is one, the Mac gets it again, and one made with another key is
 * replaced. Returns whether this browser is subscribed afterwards.
 */
export async function resyncPush(client: DaemonClient): Promise<boolean> {
  const reg = await registration();
  const existing = (await reg?.pushManager.getSubscription()) ?? null;
  if (reg === null || existing === null || Notification.permission !== 'granted') return false;
  const { key } = await readJson(await client.push.key.$get(), PushKeyDto);
  if (!sameBytes(existing.options.applicationServerKey, keyBytes(key)))
    await existing.unsubscribe();
  await subscribeAndKeep(reg, client, key, false);
  return true;
}

/** `usePushSwitchFor` with the connected daemon's client. */
export function usePushSwitch() {
  return usePushSwitchFor(useDaemon().client);
}

/**
 * This browser's push subscription and the daemon's copy of it. Turning it on asks the browser's permission,
 * subscribes with the host's VAPID key and tells the Mac; turning it off drops both. It takes its client, so the
 * pairing page, which has no connected daemon yet, can offer it the moment the phone is paired.
 */
export function usePushSwitchFor(client: DaemonClient) {
  const [state, setState] = useState<PushState>(PushState.Loading);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    registration()
      .then(async (reg) => {
        if (reg === null) return PushState.Unsupported;
        if (Notification.permission === 'denied') return PushState.Blocked;
        if ((await reg.pushManager.getSubscription()) === null) return PushState.Off;
        // On means the Mac holds it too: tell it again, and say Off if it can't be kept.
        return (await resyncPush(client).catch(() => false)) ? PushState.On : PushState.Off;
      })
      .then(
        (next) => {
          if (live) setState(next);
        },
        () => {
          if (live) setState(PushState.Unsupported);
        },
      );
    return () => {
      live = false;
    };
  }, [client]);

  async function turnOn(): Promise<void> {
    const reg = await registration();
    if (reg === null) throw new Error('This browser cannot show notifications.');
    if ((await Notification.requestPermission()) !== 'granted') {
      setState(PushState.Blocked);
      return;
    }
    const { key } = await readJson(await client.push.key.$get(), PushKeyDto);
    await subscribeAndKeep(reg, client, key, true);
    setState(PushState.On);
  }

  async function turnOff(): Promise<void> {
    const reg = await registration();
    await client.devices.me.push.$delete();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    setState(PushState.Off);
  }

  return {
    state,
    busy,
    error,
    toggle(next: boolean): void {
      setBusy(true);
      setError(null);
      (next ? turnOn() : turnOff())
        .catch((failure: unknown) => {
          setError(failure instanceof Error ? failure.message : 'Notifications did not change.');
        })
        .finally(() => {
          setBusy(false);
        });
    },
  };
}
