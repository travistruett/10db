import { z } from 'zod';

// Where a session's work happens, what the title row and the bar read about it, and the requests behind
// the git steps and Archive.

type ValueOf<T> = T[keyof T];

const Timestamp = z.iso.datetime();

/**
 * Where a session works once it goes to change files. A session that has not asked yet is reading, which
 * is `null` on the row and in `ChatWork`, never a place of its own.
 */
export const WorkPlace = {
  /** The first change was refused and the builder is being asked where it should happen. */
  Choosing: 'choosing',
  /** Working in the builder's checkout. */
  Here: 'here',
  /** A new branch's worktree is being made. */
  Moving: 'moving',
  /** Working in its own worktree on its own branch. */
  Branch: 'branch',
} as const;
export type WorkPlace = ValueOf<typeof WorkPlace>;

/** A session's place, as the Sessions screen reads it. Every field but `place` is null until it applies. */
export const ChatWork = z.object({
  place: z.enum(WorkPlace),
  branch: z.string().nullable(),
  /** The branch the work was cut from. */
  base: z.string().nullable(),
  /** Null on a branch with no worktree: archived, swept, or one that could not be remade. */
  worktree: z.string().nullable(),
  /** Bumped by each refused first change while choosing; the bar's Esc keys on it. */
  askedAt: Timestamp.nullable(),
});
export type ChatWork = z.infer<typeof ChatWork>;

/** `POST /chats/:chatId/work`: where the builder wants the work. */
export const ChatWorkChoice = z.strictObject({ place: z.enum(['here', 'branch']) });
export type ChatWorkChoice = z.infer<typeof ChatWorkChoice>;

/** The next git step the title row offers. */
export const ChatGitStep = {
  Commit: 'commit',
  OpenPullRequest: 'open_pull_request',
  Merge: 'merge',
  MergeLocal: 'merge_local',
} as const;
export type ChatGitStep = ValueOf<typeof ChatGitStep>;

const Count = z.int().nonnegative();

/** `GET /chats/:chatId/work`: the facts the title row and the bar are drawn from. */
export const ChatWorkStateDto = z.object({
  place: z.enum(WorkPlace).nullable(),
  branch: z.string().nullable(),
  base: z.string().nullable(),
  baseBranch: z.string().nullable(),
  dirtyFiles: Count,
  ahead: Count,
  /** Files changed in the builder's checkout that this session did not make. */
  uncommittedInCheckout: Count,
  /** The paths this session's allowed edits named, relative to its root. */
  touched: z.array(z.string()),
  pullRequest: z
    .object({
      number: z.int().positive(),
      url: z.string(),
      checks: z.object({ passed: Count, total: Count, failing: Count }),
      mergeable: z.boolean().nullable(),
      merged: z.boolean(),
    })
    .nullable(),
  next: z.enum(ChatGitStep).nullable(),
  /** Why `next` can't run, or the failed move's words. */
  refusal: z.string().nullable(),
  /** The bar's dim line, such as a Board task changing files on a branch. */
  holder: z.string().nullable(),
});
export type ChatWorkStateDto = z.infer<typeof ChatWorkStateDto>;

/** `POST /chats/:chatId/commit`. */
export const ChatCommitRequest = z.strictObject({
  message: z.string().trim().min(1),
  paths: z.array(z.string().min(1)).min(1),
});
export type ChatCommitRequest = z.infer<typeof ChatCommitRequest>;

/** `GET /chats/:chatId/archive-preview`: what Archive would delete with the worktree. */
export const ArchivePreviewDto = z.object({
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
  uncommitted: z.array(z.string()),
  ignored: z.array(z.string()),
});
export type ArchivePreviewDto = z.infer<typeof ArchivePreviewDto>;

/** `POST /chats/:chatId/archive`: the losses the builder was warned about. */
export const ArchiveRequest = z.strictObject({
  uncommitted: z.array(z.string()).optional(),
  ignored: z.array(z.string()).optional(),
});
export type ArchiveRequest = z.infer<typeof ArchiveRequest>;
