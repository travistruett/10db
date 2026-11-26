import { generateVAPIDKeys } from 'web-push';
import { z } from 'zod';
import type { Keychain } from '../environment';

/** The Keychain account of the host's VAPID key pair, kept as one secret: `<public>.<private>`, both base64url. */
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
    // A boundary: anyone can edit the item. The Keychain takes printable text with no quotes, so the pair is
    // joined with a dot, which base64url never holds.
    const [publicKey, privateKey, ...rest] = stored.split('.');
    const parsed = VapidKeys.safeParse({ publicKey, privateKey });
    return parsed.success && rest.length === 0 ? parsed.data : null;
  }
  return {
    read,
    async ensure() {
      const existing = await read();
      if (existing !== null) return existing;
      const made = generateVAPIDKeys();
      const keys = { publicKey: made.publicKey, privateKey: made.privateKey };
      keychain.write(VAPID_ACCOUNT, `${keys.publicKey}.${keys.privateKey}`);
      return keys;
    },
  };
}
