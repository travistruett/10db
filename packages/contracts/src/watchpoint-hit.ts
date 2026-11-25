import { z } from 'zod';

/** How loudly a watchpoint tells the builder: shown in the task, asked about in the Inbox, or held before merge. */
export const WatchpointLoudness = { Show: 'show', Ask: 'ask', Hold: 'hold' } as const;
export type WatchpointLoudness = (typeof WatchpointLoudness)[keyof typeof WatchpointLoudness];

/** What a file's section of a diff says happened to it. */
export const WatchpointFileStatus = {
  Modified: 'M',
  Added: 'A',
  Deleted: 'D',
  Renamed: 'R',
} as const;
export type WatchpointFileStatus = (typeof WatchpointFileStatus)[keyof typeof WatchpointFileStatus];

/** The most `watchpointNotes` one call sends, and the longest note. */
export const MAX_WATCHPOINT_NOTES = 40;
export const MAX_WATCHPOINT_NOTE_LENGTH = 400;

/**
 * One file's reason, from the agent that changed it (the `commit` tool) or a check from the reviewer who
 * read it (`complete_step`, prefixed ✓ or ⚠).
 */
export const WatchpointNote = z.object({
  path: z.string().min(1).max(1000),
  note: z.string().min(1).max(MAX_WATCHPOINT_NOTE_LENGTH),
});
export type WatchpointNote = z.infer<typeof WatchpointNote>;

export const WatchpointNotes = z.array(WatchpointNote).max(MAX_WATCHPOINT_NOTES);

/** The watchpoint as it was when a run matched it, so a later edit never rewrites what a task showed. */
export const WatchpointSnapshot = z.object({
  key: z.string(),
  label: z.string(),
  why: z.string(),
  guidance: z.string(),
  loudness: z.enum(WatchpointLoudness),
});
export type WatchpointSnapshot = z.infer<typeof WatchpointSnapshot>;

/** One matched file: its counts and its hunks as unified diff text, cut when the diff was too long. */
export const WatchpointFileHit = z.object({
  path: z.string(),
  status: z.enum(WatchpointFileStatus),
  /** Null for a binary file. */
  added: z.number().int().nullable(),
  removed: z.number().int().nullable(),
  patch: z.string(),
  clipped: z.boolean(),
});
export type WatchpointFileHit = z.infer<typeof WatchpointFileHit>;

export const WatchpointHit = z.object({
  watchpoint: WatchpointSnapshot,
  files: z.array(WatchpointFileHit),
});
export type WatchpointHit = z.infer<typeof WatchpointHit>;

/** What a watchpoint evidence row keeps. Changes to it stay backward compatible: stored rows are never rewritten. */
export const WatchpointDetail = z.object({
  hits: z.array(WatchpointHit),
  /** The commit that was matched. */
  head: z.string(),
  /** Set when the diff could not be read in full. */
  skipped: z.string().nullable(),
});
export type WatchpointDetail = z.infer<typeof WatchpointDetail>;

/** What a row whose detail does not parse reads as, so one bad row never stops a read of the workstream's evidence. */
export const UNREADABLE_WATCHPOINT_DETAIL: WatchpointDetail = {
  hits: [],
  head: '',
  skipped: 'unreadable',
};

/** `WatchpointDetail` as an evidence row reads it: a detail that fails to parse reads as unreadable. */
export const StoredWatchpointDetail = WatchpointDetail.catch(UNREADABLE_WATCHPOINT_DETAIL);

/** The most patch text one file keeps, and one row keeps in all. */
export const WATCHPOINT_FILE_PATCH_BYTES = 24 * 1024;
export const WATCHPOINT_ROW_PATCH_BYTES = 128 * 1024;

/** A matched file with the notes written about it: the agent's reason and the reviewer's check. */
export const WatchpointFileView = WatchpointFileHit.extend({
  agentNote: z.string().nullable(),
  reviewerNote: z.string().nullable(),
});
export type WatchpointFileView = z.infer<typeof WatchpointFileView>;

/**
 * `GET /workstreams/:id/watchpoint-hits`: the newest watchpoint row's hits with their notes joined. No row reads as no
 * hits and `at` null. `canOpenDiff` is whether the whole diff can still be read from a checkout.
 */
export const WatchpointHitsDto = z.object({
  at: z.iso.datetime().nullable(),
  head: z.string(),
  skipped: z.string().nullable(),
  hits: z.array(z.object({ watchpoint: WatchpointSnapshot, files: z.array(WatchpointFileView) })),
  canOpenDiff: z.boolean(),
});
export type WatchpointHitsDto = z.infer<typeof WatchpointHitsDto>;
