import { PushKeyDto } from '@10db/contracts';
import { useEffect, useState } from 'react';
import { readJson } from '../daemon/client';
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
 * This browser's push subscription and the daemon's copy of it. Turning it on asks the browser's permission,
 * subscribes with the host's VAPID key and tells the Mac; turning it off drops both.
 */
export function usePushSwitch() {
  const { client } = useDaemon();
  const [state, setState] = useState<PushState>(PushState.Loading);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    registration()
      .then(async (reg) => {
        if (reg === null) return PushState.Unsupported;
        if (Notification.permission === 'denied') return PushState.Blocked;
        return (await reg.pushManager.getSubscription()) === null ? PushState.Off : PushState.On;
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
  }, []);

  async function turnOn(): Promise<void> {
    const reg = await registration();
    if (reg === null) throw new Error('This browser cannot show notifications.');
    if ((await Notification.requestPermission()) !== 'granted') {
      setState(PushState.Blocked);
      return;
    }
    const { key } = await readJson(await client.push.key.$get(), PushKeyDto);
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(key),
    });
    const json = subscription.toJSON();
    const { p256dh, auth } = json.keys ?? {};
    if (json.endpoint === undefined || p256dh === undefined || auth === undefined) {
      await subscription.unsubscribe();
      throw new Error('The browser gave no push keys.');
    }
    const kept = await client.devices.me.push.$put({
      json: { endpoint: json.endpoint, p256dh, auth },
    });
    if (!kept.ok) {
      await subscription.unsubscribe();
      throw new Error('The Mac did not keep this phone for notifications.');
    }
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
