import { DeviceId } from '@10db/contracts';
import { z } from 'zod';

/** What the phone keeps of its pairing: the credential, who it is, and the Mac's name for the messages. */
const StoredDevice = z.object({
  deviceId: DeviceId,
  token: z.string().min(1),
  host: z.string().min(1),
});
export type StoredDevice = z.infer<typeof StoredDevice>;

const DEVICE_KEY = 'tendb.device';
/** The Mac's name, kept after the daemon revoked the device so the page can say who removed it. */
const REMOVED_KEY = 'tendb.removedFrom';

export function readDevice(): StoredDevice | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (raw === null) return null;
    const parsed = StoredDevice.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveDevice(device: StoredDevice): void {
  localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
  localStorage.removeItem(REMOVED_KEY);
}

/** Drops the credential. `removedBy` names the Mac that revoked it; null when the builder forgot it here. */
export function forgetDevice(removedBy: string | null): void {
  localStorage.removeItem(DEVICE_KEY);
  if (removedBy === null) localStorage.removeItem(REMOVED_KEY);
  else localStorage.setItem(REMOVED_KEY, removedBy);
}

/** The Mac that removed this device, until it is paired again; null when it was never removed. */
export function removedBy(): string | null {
  return localStorage.getItem(REMOVED_KEY);
}

let forgetting = false;

/** Set around Forget This Device: the 401 its own revoke brings is not the Mac removing the device. */
export function setForgetting(on: boolean): void {
  forgetting = on;
}

export const isForgetting = (): boolean => forgetting;
