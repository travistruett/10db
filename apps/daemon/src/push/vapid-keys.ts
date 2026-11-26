import { generateVAPIDKeys } from 'web-push';
import { z } from 'zod';
import type { Keychain } from '../environment';

/** The Keychain account of the host's VAPID key pair, kept as one JSON secret. */
export const VAPID_ACCOUNT = 'web-push-vapid';

const VapidKeys = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });
export type VapidKeys = z.infer<typeof VapidKeys>;

export interface VapidKeyStore {
  /** The key pair, made and kept on first use. */
  ensure(): Promise<VapidKeys>;
  /** The key pair when one exists; never makes one, so a Mac nobody subscribed on holds none. */
  read(): Promise<VapidKeys | null>;
}

/** The host's push identity in the login Keychain; a new Mac makes its own, which pairing re-subscribes to. */
export function createVapidKeyStore(keychain: Keychain): VapidKeyStore {
  async function read(): Promise<VapidKeys | null> {
    const stored = await keychain.readAsync(VAPID_ACCOUNT);
    if (stored === null) return null;
    try {
      // A boundary: the Keychain item is a file we wrote, but anyone can edit it.
      const parsed = VapidKeys.safeParse(JSON.parse(stored));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  return {
    read,
    async ensure() {
      const existing = await read();
      if (existing !== null) return existing;
      const made = generateVAPIDKeys();
      const keys = { publicKey: made.publicKey, privateKey: made.privateKey };
      keychain.write(VAPID_ACCOUNT, JSON.stringify(keys));
      return keys;
    },
  };
}
