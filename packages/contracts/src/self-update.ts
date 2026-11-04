import { z } from 'zod';
import { ShapeId } from './ids';

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
 * rolled back from it), `unbuilt` (it has no finished build newer than the running one yet),
 * `fetching` (nothing is staged yet: its build is being fetched, or waited for while GitHub builds
 * it, which can take many minutes), `unreachable` (no staged build can install, because none is
 * staged or the kept one is held back, and no check is fetching: GitHub could not be asked, so the
 * build is fetched once it answers).
 */
export const SelfUpdateNotInstalling = z.enum([
  'failed',
  'rolled-back',
  'unbuilt',
  'fetching',
  'unreachable',
]);
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
   * none available. Install Now does nothing for `failed` or `rolled-back`; for `unbuilt`,
   * `fetching` and `unreachable` the daemon remembers it, and drains the moment a build is staged.
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
   * What the update waits for now, as counts. `working` is what a quit would cut off and the
   * update always waits for: lanes and gates that run, batches being cut or shipped, delivery jobs
   * and shaping turns. `waitingOnCard` is lanes parked on an unanswered permission or ask card with
   * a session still live: they hold the update only until the drain begins, because a restart ends
   * the session and recovery parks the lane on its card again, to resume with the answer.
   * `batches` and `jobs` are the batches being cut or shipped and the delivery jobs (a queued ship,
   * checkout return or cleanup) counted in `working`, and `shapes` names the shaping conversations
   * whose turn is under way and counted there too: what remains of `working` is the lanes and gates
   * on the Board. A builder can then be told where to look for what the update waits for.
   */
  midSession: z.object({
    working: z.number().int().min(0),
    waitingOnCard: z.number().int().min(0),
    batches: z.number().int().min(0),
    jobs: z.number().int().min(0),
    shapes: z.array(z.object({ id: ShapeId, title: z.string() })),
  }),
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

/** The switch's label in Settings; cards and messages name it exactly. */
export const SELF_UPDATE_SWITCH = 'Update 10db by itself';

/**
 * What the builder can do about a shaping turn that holds the update, for the card and for Settings
 * alike. Stop only interrupts, and a hung session may not answer that; the switch ends the drain and
 * quitting ends the session whatever the session does.
 */
export const SHAPE_HOLD_WAY_OUT = `If it is stuck, open the conversation and press Stop. If that does not end it, turn ${SELF_UPDATE_SWITCH} off in Settings, which starts lanes again without the update, or quit 10db.`;

/** The longest wait limit: a day. */
export const MAX_SELF_UPDATE_WAIT_MINUTES = 1440;

/** `PUT /settings/self-update/wait`: minutes a staged build waits before draining; null is the default. */
export const SelfUpdateWaitInput = z.object({
  minutes: z.number().int().min(0).max(MAX_SELF_UPDATE_WAIT_MINUTES).nullable(),
});
export type SelfUpdateWaitInput = z.infer<typeof SelfUpdateWaitInput>;
