import { z } from 'zod';
import { DeviceId } from './ids';

export const DevicePlatform = {
  Android: 'android',
  Ios: 'ios',
  Macos: 'macos',
  Other: 'other',
} as const;
export type DevicePlatform = (typeof DevicePlatform)[keyof typeof DevicePlatform];

export const DEVICE_LABEL_MAX = 60;

export const DeviceDto = z.object({
  id: DeviceId,
  label: z.string().min(1).max(DEVICE_LABEL_MAX),
  platform: z.enum(DevicePlatform),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type DeviceDto = z.infer<typeof DeviceDto>;

/** 8 Crockford base32 characters, shown as two groups of four. */
export const PAIRING_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export const PairingCodeDto = z.object({
  code: z.string().regex(PAIRING_CODE),
  expiresAt: z.iso.datetime(),
  /** `https://<fqdn>:<port>/app/pair#code=<code>`. */
  url: z.string(),
});
export type PairingCodeDto = z.infer<typeof PairingCodeDto>;

/** Crockford's reading rules: upper-case, no `-` or whitespace, I and L read as 1, O as 0. */
function normalisePairingCode(code: string): string {
  return code.toUpperCase().replace(/[-\s]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

export const PairRequest = z.object({
  code: z.string().max(16).transform(normalisePairingCode),
  label: z.string().trim().min(1).max(DEVICE_LABEL_MAX),
  platform: z.enum(DevicePlatform),
});
export type PairRequest = z.infer<typeof PairRequest>;

export const PairResponse = z.object({
  deviceId: DeviceId,
  token: z.string(),
  host: z.object({
    name: z.string(),
    fqdn: z.string(),
    port: z.int(),
    protocolVersion: z.int(),
  }),
});
export type PairResponse = z.infer<typeof PairResponse>;

export const DeviceChange = { Paired: 'paired', Used: 'used', Revoked: 'revoked' } as const;
export type DeviceChange = (typeof DeviceChange)[keyof typeof DeviceChange];

/** `entityId` of the event is the DeviceId. */
export const DeviceChangedData = z.object({ change: z.enum(DeviceChange) });
export type DeviceChangedData = z.infer<typeof DeviceChangedData>;
