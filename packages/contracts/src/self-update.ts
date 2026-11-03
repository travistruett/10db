import { z } from 'zod';

/** A full git commit SHA, as GitHub and `git rev-parse` print it. */
export const CommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'must be a full 40-character commit SHA');
export type CommitSha = z.infer<typeof CommitSha>;

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
});
export type SelfUpdateStatusDto = z.infer<typeof SelfUpdateStatusDto>;

/** `PUT /settings/self-update`: on, off, or null to go back to the default. */
export const SelfUpdateInput = z.object({ enabled: z.boolean().nullable() });
export type SelfUpdateInput = z.infer<typeof SelfUpdateInput>;
