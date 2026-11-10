import { z } from 'zod';
import { GitObjectName } from './git-names';
import { PassId, TaskId } from './ids';
import { SharedSeq } from './pass-shared';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §7.2, §9.2, §5.4: the
// `data` of the pass events the Workbench follows, beside `pass.changed`.

/** `pass.shared_changed`: a shared change kept, replaced, or dropped (a drop names its own number). */
export const PassSharedChangedData = z.object({
  passId: PassId,
  seq: SharedSeq,
  taskId: TaskId,
  paths: z.array(z.string()),
});
export type PassSharedChangedData = z.infer<typeof PassSharedChangedData>;

/** `pass.page_signed_off`: the page's commit (null when nothing landed), its files, and the shared changes landed with it. */
export const PassPageSignedOffData = z.object({
  passId: PassId,
  taskId: TaskId,
  landedSha: GitObjectName.nullable(),
  files: z.array(z.string()),
  sharedLanded: z.array(SharedSeq),
});
export type PassPageSignedOffData = z.infer<typeof PassPageSignedOffData>;

/** `pass.closed`: `settled` when the close settled it too (a `local` project, or no `origin` or `gh`). */
export const PassClosedData = z.object({ passId: PassId, settled: z.boolean() });
export type PassClosedData = z.infer<typeof PassClosedData>;

/** How a closed pass settled (D22): its branch realigned with the base, moved by the builder, or local. */
export const PassSettledHow = { Realigned: 'realigned', Moved: 'moved', Local: 'local' } as const;
export type PassSettledHow = (typeof PassSettledHow)[keyof typeof PassSettledHow];

/** `pass.settled`. */
export const PassSettledData = z.object({ passId: PassId, how: z.enum(PassSettledHow) });
export type PassSettledData = z.infer<typeof PassSettledData>;
