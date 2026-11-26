import { z } from 'zod';
import { EvalDefinitionHit } from './eval-definition-change';

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

/** A note is one line: a lane's words reach a reviewer's brief, where a line break could pass for the brief's own. */
const ONE_LINE = /^[^\r\n]+$/;

/**
 * One file's reason, from the agent that changed it (the `commit` tool) or a check from the reviewer who
 * read it (`complete_step`, prefixed ✓ or ⚠).
 */
export const WatchpointNote = z.object({
  path: z.string().min(1).max(1000).regex(ONE_LINE, 'one line'),
  note: z.string().min(1).max(MAX_WATCHPOINT_NOTE_LENGTH).regex(ONE_LINE, 'one line'),
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
  /** Set when the file defines an eval suite: what the change did to it. */
  evalDefinition: EvalDefinitionHit.optional(),
});
export type WatchpointFileHit = z.infer<typeof WatchpointFileHit>;

export const WatchpointHit = z.object({
  watchpoint: WatchpointSnapshot,
  files: z.array(WatchpointFileHit),
});
export type WatchpointHit = z.infer<typeof WatchpointHit>;

/**
 * A watchpoint's question as the judge answered it in shadow: the files whose hunks it read (of those its globs cover
 * and no line settled), how many more it was not shown, and the probability of yes, null when no answer came.
 * Nothing acts on it.
 */
export const WatchpointShadow = z.object({
  key: z.string(),
  label: z.string(),
  asked: z.array(z.string()),
  /** The files left open past what the judge could read. */
  more: z.int().nonnegative().default(0),
  yes: z.number().min(0).max(1).nullable(),
});
export type WatchpointShadow = z.infer<typeof WatchpointShadow>;

/** What a watchpoint evidence row keeps. Changes to it stay backward compatible: stored rows are never rewritten. */
export const WatchpointDetail = z.object({
  hits: z.array(WatchpointHit),
  /** The commit that was matched. */
  head: z.string(),
  /** Set when the diff could not be read in full. */
  skipped: z.string().nullable(),
  /** The questions asked in shadow; absent when none was. Never a hit, and nothing reads it to act. */
  shadow: z.array(WatchpointShadow).optional(),
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
/** The most patch text read, in all, to test the line patterns of the watchpoints that have them. */
export const WATCHPOINT_LINE_SCAN_BYTES = 512 * 1024;

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

/** What the builder answers on a Look card. */
export const WatchpointChoice = { LooksRight: 'looks_right', SendBack: 'send_back' } as const;
export type WatchpointChoice = (typeof WatchpointChoice)[keyof typeof WatchpointChoice];

/**
 * What a Look card keeps: which watchpoints the change hit. The card holds no hunks; it reads them live from
 * `GET /workstreams/:id/watchpoint-hits`.
 */
export const WatchpointCardDetail = z.object({
  watchpoints: z.array(z.object({ key: z.string(), label: z.string() })),
});
export type WatchpointCardDetail = z.infer<typeof WatchpointCardDetail>;
