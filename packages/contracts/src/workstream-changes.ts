import { z } from 'zod';

/** One file a workstream changed. A binary file has no line counts. */
export const ChangedFileDto = z.object({
  path: z.string(),
  added: z.int().min(0).nullable(),
  removed: z.int().min(0).nullable(),
});
export type ChangedFileDto = z.infer<typeof ChangedFileDto>;

/**
 * What a workstream changed in its checkout, from the head it started at to its head now: the
 * commits, the unified diff (cut at a size cap, with `truncated` set when it was) and the per-file
 * line counts, which always cover every file.
 */
export const WorkstreamChangesDto = z.object({
  baseHead: z.string(),
  head: z.string(),
  commits: z.array(z.string()),
  diff: z.string(),
  truncated: z.boolean(),
  files: z.array(ChangedFileDto),
});
export type WorkstreamChangesDto = z.infer<typeof WorkstreamChangesDto>;
