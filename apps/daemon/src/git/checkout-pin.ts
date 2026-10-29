import type { BatchId } from '@10db/contracts';
import { z } from 'zod';

/**
 * What the daemon trusts about a checkout, recorded when it first works there and kept until the
 * builder re-trusts it: its git dirs by device and inode, and origin's fetch and push URLs.
 */
export const CheckoutPin = z.object({
  gitDir: z.string().startsWith('/'),
  commonDir: z.string().startsWith('/'),
  /** `<dev>:<ino>/<dev>:<ino>` of the git dir and the common dir. */
  id: z.string().min(1),
  fetchUrl: z.string().min(1).nullable(),
  pushUrl: z.string().min(1).nullable(),
});
export type CheckoutPin = z.infer<typeof CheckoutPin>;

/** The inodes of an identity's git dir and common dir, without the device numbers. */
export function identityInodes(id: string): string {
  return id
    .split('/')
    .map((part) => part.slice(part.indexOf(':') + 1))
    .join('/');
}

/**
 * True when two identities name the same git dirs. The device number is left out: macOS renumbers
 * the Data volume when it remounts it (after an OS update), so a checkout keeps its inodes but not
 * its device. A `.git` replaced at the same path still gets a new inode.
 */
export function sameCheckoutIdentity(a: string, b: string): boolean {
  return identityInodes(a) === identityInodes(b);
}

/** The app setting a batch's worktree pin is kept under. */
export const worktreePinKey = (batchId: BatchId): string => `checkout_pin.${batchId}`;

/** Where pins live, keyed by the checkout's real path. */
export interface PinStore {
  get(repo: string): CheckoutPin | undefined;
  set(repo: string, pin: CheckoutPin): void;
  delete(repo: string): void;
}

/** Pins that last as long as the process: for tests and for a checkout no project uses. */
export function memoryPinStore(): PinStore {
  const pins = new Map<string, CheckoutPin>();
  return {
    get: (repo) => pins.get(repo),
    set: (repo, pin) => {
      pins.set(repo, pin);
    },
    delete: (repo) => {
      pins.delete(repo);
    },
  };
}
