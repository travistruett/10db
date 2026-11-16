import { z } from 'zod';
import { ChatId, ProjectId } from './ids';

// Sessions spec §7.3: who has Your folder. A chat writes there only while its turn holds it, and 10db's
// own writers (a task, a pass, its git work) keep it to themselves; attended holders share.

/** What holds Your folder. A pass is split by phase: an open or closing one and a closed one limit a chat differently. */
export const FolderHolderKind = {
  Lane: 'lane',
  PassOpen: 'pass_open',
  PassClosed: 'pass_closed',
  GitWork: 'git_work',
  ChatTurn: 'chat_turn',
  WaitingChat: 'waiting_chat',
  Takeover: 'takeover',
} as const;
export type FolderHolderKind = (typeof FolderHolderKind)[keyof typeof FolderHolderKind];

/** Who is asking for the folder. */
export const FolderAsker = {
  LaneStart: 'lane_start',
  GitWork: 'git_work',
  ChatTurn: 'chat_turn',
  Takeover: 'takeover',
} as const;
export type FolderAsker = (typeof FolderAsker)[keyof typeof FolderAsker];

/** What a holder does to an asker. */
export const FolderOutcome = {
  /** Both use the folder at once. */
  Shares: 'shares',
  /** The asker waits for the holder to leave. */
  Waits: 'waits',
  /** The asker is refused; nothing is queued. */
  Refused: 'refused',
  /** A chat runs on the read-only profile, or waits, as the builder picks. */
  ReadsOrWaits: 'reads_or_waits',
} as const;
export type FolderOutcome = (typeof FolderOutcome)[keyof typeof FolderOutcome];

/** The notice a task in Your folder shows while a chat holds or waits for the folder. */
export const FOLDER_HOLD_WAIT_NOTICE_KEY = 'folder-hold';

/**
 * What to do when a pass is refused because chats are mid-turn: stop their turns and open, or open when they
 * have ended.
 */
export const PassWhenBusy = { StopTurns: 'stop_turns', Wait: 'wait' } as const;
export type PassWhenBusy = (typeof PassWhenBusy)[keyof typeof PassWhenBusy];

/** An open that waits for Your folder: the pass's name and what it waits for, in words. */
export const PendingOpenDto = z.object({ name: z.string(), waitsFor: z.string() });
export type PendingOpenDto = z.infer<typeof PendingOpenDto>;

/** What a chat's send does when Your folder is held: wait for it, or run reading only. */
export const FolderWhileHeld = { Wait: 'wait', ReadOnly: 'read_only' } as const;
export type FolderWhileHeld = (typeof FolderWhileHeld)[keyof typeof FolderWhileHeld];
export const FolderWhileHeldInput = z.enum(FolderWhileHeld);

/**
 * One holder of Your folder, as the words name it. `name` is the task's, pass's or chat's title (the
 * first of a lane's when `more` counts the others) and is empty for 10db's git work, whose `what` says it.
 */
export const FolderHolderDto = z.object({
  kind: z.enum(FolderHolderKind),
  name: z.string(),
  /** How many more of the same kind hold it: a lane's `more` counts the other tasks. */
  more: z.int().nonnegative(),
  /** The chat, for a chat's turn, a waiting chat or a taken-over chat. */
  chatId: ChatId.nullable(),
  /** What 10db's git work is doing, for `git_work`: "switching Your folder back to `main`". */
  what: z.string().nullable(),
});
export type FolderHolderDto = z.infer<typeof FolderHolderDto>;

/** A limit the holders put on a chat that holds the folder anyway. */
export const FolderLimit = {
  /** The folder git tools wait until a closed pass's pull request merges. */
  FolderGitUntilMerge: 'folder_git_until_merge',
} as const;
export type FolderLimit = (typeof FolderLimit)[keyof typeof FolderLimit];

/** A holder with the words that name it ("the task ‘Bump vite’ and 2 more"), and whether it keeps a chat's turn out. */
export const FolderHolderView = FolderHolderDto.extend({
  words: z.string(),
  /** A chat's turn can't hold the folder with it: the turn waits or reads only. */
  keepsChatOut: z.boolean(),
});
export type FolderHolderView = z.infer<typeof FolderHolderView>;

/** Who holds a project's checkout now, for the session bar and the composer. */
export const FolderDto = z.object({
  projectId: ProjectId,
  /** The branch Your folder is on, or null when it can't be read or is detached. */
  branch: z.string().nullable(),
  holders: z.array(FolderHolderView),
  limits: z.array(z.enum(FolderLimit)),
  /** The name of the closed pass the limit waits on, when there is one. */
  limitPass: z.string().nullable(),
  /** The pass open waiting for chats to end, or null. */
  pendingOpen: PendingOpenDto.nullable(),
});
export type FolderDto = z.infer<typeof FolderDto>;
