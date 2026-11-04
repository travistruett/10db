import { z } from 'zod';

/** A full git commit SHA, as GitHub and `git rev-parse` print it. */
export const CommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'must be a full 40-character commit SHA');
export type CommitSha = z.infer<typeof CommitSha>;

/**
 * Why an app that is switched on will not update itself: what the builder can read under the switch.
 * `source`, `no-repository`, `not-in-applications` and `gh-missing` last until the app is replaced
 * or gh is installed; `unreachable` lasts while GitHub can't be asked; `failed` until the builder
 * touches the switch or main moves on.
 */
export const SelfUpdateBlockerKind = z.enum([
  'source',
  'no-repository',
  'not-in-applications',
  'gh-missing',
  'unreachable',
  'failed',
]);
export type SelfUpdateBlockerKind = z.infer<typeof SelfUpdateBlockerKind>;

export const SelfUpdateBlockerDto = z.object({
  kind: SelfUpdateBlockerKind,
  /** A sentence or two for the builder, naming what to do about it. */
  message: z.string().min(1),
});
export type SelfUpdateBlockerDto = z.infer<typeof SelfUpdateBlockerDto>;

/**
 * Why an available update does not wait for an idle moment: `failed` (its update failed and is not
 * tried again until main moves on or the builder touches the switch), `rolled-back` (the builder
 * rolled back from it), `unbuilt` (it has no finished build newer than the running one yet).
 */
export const SelfUpdateNotInstalling = z.enum(['failed', 'rolled-back', 'unbuilt']);
export type SelfUpdateNotInstalling = z.infer<typeof SelfUpdateNotInstalling>;

/**
 * `GET /settings/self-update`: whether 10db installs main's build by itself, and which commits are
 * involved. One setting for the whole app, on until the builder turns it off. What it follows is
 * not a setting: it is the repository the app was built for.
 */
export const SelfUpdateStatusDto = z.object({
  /** The effective setting: the builder's choice, else on. */
  enabled: z.boolean(),
  /** True while the builder has made no choice, so `enabled` is the default. */
  isDefault: z.boolean(),
  /** The commit this app was built from; null for a source run, which never updates itself. */
  runningCommit: CommitSha.nullable(),
  /** The commit at the head of main when 10db last saw it ahead of the running one; null otherwise. */
  availableCommit: CommitSha.nullable(),
  /**
   * Why `availableCommit` is not going to install: null while it waits, drains or installs, and with
   * none available. Install Now does nothing when this is set.
   */
  notInstalling: SelfUpdateNotInstalling.nullable(),
  /** Minutes a staged build waits for an idle moment before the factory drains for it. */
  waitMinutes: z.number().int().min(0),
  /** When the staged build began to wait; null with no staged build. */
  waitingSince: z.iso.datetime().nullable(),
  /**
   * True while the factory drains for the update: no new lane step, session, gate or ship starts,
   * and what runs finishes, then the app installs and relaunches.
   */
  draining: z.boolean(),
  /** When new work stopped starting; null while it is not held. */
  drainingSince: z.iso.datetime().nullable(),
  /**
   * Why this app will not update itself, whatever the switch says; null when nothing stops it. The
   * ones that last (a source run, a copy outside Applications, no repository, no gh) show even with
   * the switch off; a GitHub that can't be reached and a failed update show only while it is on.
   */
  blocker: SelfUpdateBlockerDto.nullable(),
});
export type SelfUpdateStatusDto = z.infer<typeof SelfUpdateStatusDto>;

/** `PUT /settings/self-update`: on, off, or null to go back to the default. */
export const SelfUpdateInput = z.object({ enabled: z.boolean().nullable() });
export type SelfUpdateInput = z.infer<typeof SelfUpdateInput>;

/** The longest wait limit: a day. */
export const MAX_SELF_UPDATE_WAIT_MINUTES = 1440;

/** `PUT /settings/self-update/wait`: minutes a staged build waits before draining; null is the default. */
export const SelfUpdateWaitInput = z.object({
  minutes: z.number().int().min(0).max(MAX_SELF_UPDATE_WAIT_MINUTES).nullable(),
});
export type SelfUpdateWaitInput = z.infer<typeof SelfUpdateWaitInput>;
