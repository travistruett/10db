import { z } from 'zod';

export const SHARE_PORT_DEFAULT = 4319;

/** Tailscale Funnel's ports; 443 also holds the builder's own serve config. Share refuses them. */
export const FUNNEL_PORTS = [443, 8443, 10000] as const;

export const SharingState = {
  Off: 'off',
  SettingUp: 'setting_up',
  Ready: 'ready',
  Paused: 'paused',
} as const;
export type SharingState = (typeof SharingState)[keyof typeof SharingState];

export const SharingStep = {
  Installed: 'installed',
  Connected: 'connected',
  Untagged: 'untagged',
  Https: 'https',
  Certificate: 'certificate',
  Shared: 'shared',
} as const;
export type SharingStep = (typeof SharingStep)[keyof typeof SharingStep];

export const SharingStepStatus = {
  Ok: 'ok',
  Waiting: 'waiting',
  Failed: 'failed',
  Todo: 'todo',
} as const;
export type SharingStepStatus = (typeof SharingStepStatus)[keyof typeof SharingStepStatus];

export const SharingStepDto = z.object({
  step: z.enum(SharingStep),
  status: z.enum(SharingStepStatus),
  /** A path, a version, the tailnet name or a certificate's expiry. */
  detail: z.string().nullable(),
  /** The CLI's stderr or 10db's reason, verbatim, for a failed or waiting step. */
  error: z.string().nullable(),
});
export type SharingStepDto = z.infer<typeof SharingStepDto>;

export const SharingStatusDto = z.object({
  state: z.enum(SharingState),
  /** `sharing.enabled`. */
  enabled: z.boolean(),
  port: z.int().min(1024).max(65535),
  /** `Self.DNSName` without its trailing dot; never stored. */
  fqdn: z.string().nullable(),
  login: z.string().nullable(),
  /** The builder pressed Get Certificate for this name (`sharing.certificateFor`). */
  certificateRequested: z.boolean(),
  /** A probe passed for this name, so it is already in the logs. */
  certificateExists: z.boolean(),
  /** `https://<fqdn>:<port>` once Ready. */
  url: z.string().nullable(),
  /** `<command> (pid <n>)` when the share port is taken by another process. */
  portHolder: z.string().nullable(),
  /** In `SharingStep` order; empty while the CLI isn't found. */
  steps: z.array(SharingStepDto),
});
export type SharingStatusDto = z.infer<typeof SharingStatusDto>;

export const PutSharingBody = z.object({
  enabled: z.boolean(),
  port: z.int().min(1024).max(65535).optional(),
});
export type PutSharingBody = z.infer<typeof PutSharingBody>;
