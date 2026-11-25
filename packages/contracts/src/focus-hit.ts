import { z } from 'zod';

/** How loudly a focus tells the builder: shown in the task, asked about in the Inbox, or held before merge. */
export const FocusLoudness = { Show: 'show', Ask: 'ask', Hold: 'hold' } as const;
export type FocusLoudness = (typeof FocusLoudness)[keyof typeof FocusLoudness];

/** What a file's section of a diff says happened to it. */
export const FocusFileStatus = { Modified: 'M', Added: 'A', Deleted: 'D', Renamed: 'R' } as const;
export type FocusFileStatus = (typeof FocusFileStatus)[keyof typeof FocusFileStatus];

/** The most `focusNotes` one call sends, and the longest note. */
export const MAX_FOCUS_NOTES = 40;
export const MAX_FOCUS_NOTE_LENGTH = 400;

/**
 * One file's reason, from the agent that changed it (the `commit` tool) or a check from the reviewer who
 * read it (`complete_step`, prefixed ✓ or ⚠).
 */
export const FocusNote = z.object({
  path: z.string().min(1).max(1000),
  note: z.string().min(1).max(MAX_FOCUS_NOTE_LENGTH),
});
export type FocusNote = z.infer<typeof FocusNote>;

export const FocusNotes = z.array(FocusNote).max(MAX_FOCUS_NOTES);

/** The focus as it was when a run matched it, so a later edit never rewrites what a task showed. */
export const FocusSnapshot = z.object({
  key: z.string(),
  label: z.string(),
  why: z.string(),
  guidance: z.string(),
  loudness: z.enum(FocusLoudness),
});
export type FocusSnapshot = z.infer<typeof FocusSnapshot>;

/** One matched file: its counts and its hunks as unified diff text, cut when the diff was too long. */
export const FocusFileHit = z.object({
  path: z.string(),
  status: z.enum(FocusFileStatus),
  /** Null for a binary file. */
  added: z.number().int().nullable(),
  removed: z.number().int().nullable(),
  patch: z.string(),
  clipped: z.boolean(),
});
export type FocusFileHit = z.infer<typeof FocusFileHit>;

export const FocusHit = z.object({ focus: FocusSnapshot, files: z.array(FocusFileHit) });
export type FocusHit = z.infer<typeof FocusHit>;

/** What a focus evidence row keeps. Changes to it stay backward compatible: stored rows are never rewritten. */
export const FocusDetail = z.object({
  hits: z.array(FocusHit),
  /** The commit that was matched. */
  head: z.string(),
  /** Set when the diff could not be read in full. */
  skipped: z.string().nullable(),
});
export type FocusDetail = z.infer<typeof FocusDetail>;

/** What a row whose detail does not parse reads as, so one bad row never stops a read of the workstream's evidence. */
export const UNREADABLE_FOCUS_DETAIL: FocusDetail = { hits: [], head: '', skipped: 'unreadable' };

/** `FocusDetail` as an evidence row reads it: a detail that fails to parse reads as unreadable. */
export const StoredFocusDetail = FocusDetail.catch(UNREADABLE_FOCUS_DETAIL);

/** The most patch text one file keeps, and one row keeps in all. */
export const FOCUS_FILE_PATCH_BYTES = 24 * 1024;
export const FOCUS_ROW_PATCH_BYTES = 128 * 1024;

/** A matched file with the notes written about it: the agent's reason and the reviewer's check. */
export const FocusFileView = FocusFileHit.extend({
  agentNote: z.string().nullable(),
  reviewerNote: z.string().nullable(),
});
export type FocusFileView = z.infer<typeof FocusFileView>;

/**
 * `GET /workstreams/:id/focus-hits`: the newest focus row's hits with their notes joined. No row reads as no
 * hits and `at` null. `canOpenDiff` is whether the whole diff can still be read from a checkout.
 */
export const FocusHitsDto = z.object({
  at: z.iso.datetime().nullable(),
  head: z.string(),
  skipped: z.string().nullable(),
  hits: z.array(z.object({ focus: FocusSnapshot, files: z.array(FocusFileView) })),
  canOpenDiff: z.boolean(),
});
export type FocusHitsDto = z.infer<typeof FocusHitsDto>;
