import type { LaneSandboxSettings } from './profile';

/**
 * The settings file `srt` (`@anthropic-ai/sandbox-runtime`) reads, in its own field names: the same
 * engine and field names as Claude Code's sandbox, whose settings are built on it. Only what 10db
 * sets is here; srt refuses a file it can't validate rather than fall back to its defaults.
 */
export interface SrtSettings {
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    /** Hosts off the list are denied: no callback is asked, and no per-command list widens it. */
    readonly strictAllowlist: true;
    readonly allowLocalBinding?: true;
    readonly allowMachLookup: readonly string[];
    readonly allowUnixSockets: readonly string[];
  };
  readonly filesystem: {
    readonly denyRead: readonly string[];
    readonly allowRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
  };
  readonly allowAppleEvents: false;
}

/**
 * srt's settings for a validated profile. Its env list is left out: srt passes on the env it is
 * started with, and the caller builds that from the allowlist.
 */
export function srtSettings(profile: LaneSandboxSettings): SrtSettings {
  const { network, filesystem } = profile;
  return {
    network: {
      allowedDomains: network.allowedDomains,
      deniedDomains: [],
      strictAllowlist: true,
      ...(network.allowLocalBinding === true ? { allowLocalBinding: true } : {}),
      allowMachLookup: network.allowMachLookup,
      allowUnixSockets: network.allowUnixSockets,
    },
    filesystem: {
      denyRead: filesystem.denyRead,
      allowRead: filesystem.allowRead,
      allowWrite: filesystem.allowWrite,
      denyWrite: filesystem.denyWrite,
    },
    allowAppleEvents: false,
  };
}
