import { z } from 'zod';
import { GitObjectName } from './git-names';
import { TaskId } from './ids';
import { SharedSeq } from './pass-shared';
import { PassDto, SharedChoice } from './passes';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §5.4, §7.2, §8.3, §9.2:
// what the routes of a pass's sign-off, pull request, take-out and close answer and take.

/** `POST /passes/:passId/tasks/:taskId/sign-off` answers 202: landing now, or waiting for a hold. */
export const PassSignOffDto = z.object({
  taskId: TaskId,
  state: z.enum(['signing_off', 'waiting']),
  /** The page whose turn holds what this page needs; null unless waiting. */
  waitsFor: z.object({ taskId: TaskId, title: z.string() }).nullable(),
});
export type PassSignOffDto = z.infer<typeof PassSignOffDto>;

/** Where the gate of a pass's pull request runs: a scratch worktree, the folder at close, or nowhere. */
export const PassPullRequestGate = {
  Scratch: 'scratch',
  FolderAtClose: 'folder_at_close',
  None: 'none',
} as const;
export type PassPullRequestGate = (typeof PassPullRequestGate)[keyof typeof PassPullRequestGate];

/** `GET /passes/:passId/pull-request`: whether Open Pull Request is offered, and what it would do. */
export const PassPullRequestPreviewDto = z.object({
  offered: z.boolean(),
  /** Why it is not offered; null when it is. */
  reason: z.string().nullable(),
  /** The commits the pass's branch has that the base on `origin` lacks; null with no base to compare. */
  aheadOfBase: z.int().min(0).nullable(),
  /** The branch the pull request targets: the base, or the branch of the pass this one is stacked on. */
  base: z.string(),
  existing: z.object({ url: z.string(), draft: z.boolean() }).nullable(),
  gate: z.enum(PassPullRequestGate),
});
export type PassPullRequestPreviewDto = z.infer<typeof PassPullRequestPreviewDto>;

/** `POST /passes/:passId/pull-request` answers 202 with what it started. */
export const PassPullRequestDto = z.object({
  /** The pull request; null until the push and create have finished. */
  url: z.string().nullable(),
  base: z.string(),
  gate: z.enum(PassPullRequestGate),
  /** The one review (D21): started, not run because the tip it read is unchanged, or none configured. */
  review: z.enum(['started', 'unchanged', 'none']),
});
export type PassPullRequestDto = z.infer<typeof PassPullRequestDto>;

/** A shared change of a page that has not landed, as a take-out or a close offers Keep and Drop for it. */
export const SharedUnlandedDto = z.object({
  seq: SharedSeq,
  paths: z.array(z.string()),
  /** Why only Keep is offered (a later change touches the paths, or the files changed on disk); null when Drop is. */
  dropRefusal: z.string().nullable(),
  /** The pages that changed these paths later, named first in the Drop's confirm. */
  laterPages: z.array(z.string()),
});
export type SharedUnlandedDto = z.infer<typeof SharedUnlandedDto>;

/** `GET /passes/:passId/tasks/:taskId/take-out`: the page's shared changes that have not landed. */
export const TakeOutPreviewDto = z.object({ shared: z.array(SharedUnlandedDto) });
export type TakeOutPreviewDto = z.infer<typeof TakeOutPreviewDto>;

/** `POST /passes/:passId/tasks/:taskId/take-out`: Keep or Drop for each; a change not named is kept. */
export const TakeOutRequest = z.object({ shared: z.array(SharedChoice).default([]) });
export type TakeOutRequest = z.infer<typeof TakeOutRequest>;

/** Where a close runs its gate, and what a failure there costs (spec §5.4 step 5). */
export const PassCloseGate = z.object({
  where: z.enum(['scratch', 'folder', 'none']),
  /** Said in the modal for a gate in the folder: a failure reopens the pass with pages taken out. */
  consequence: z.string().nullable(),
});
export type PassCloseGate = z.infer<typeof PassCloseGate>;

/**
 * `GET /passes/:passId/close` (D25: it stops nothing): the unfinished pages, the files no page owns,
 * commits on the branch 10db did not make, the summary line, where the gate runs, and a token naming
 * these lists, so a close confirmed on lists that changed is shown again.
 */
export const PassClosePreviewDto = z.object({
  token: z.string().min(1),
  unfinished: z.array(
    z.object({
      taskId: TaskId,
      title: z.string(),
      /** The page's agent is working; Close Pass stops it. */
      working: z.boolean(),
      sharedUnlanded: z.array(SharedUnlandedDto),
    }),
  ),
  unowned: z.array(
    z.object({
      path: z.string(),
      added: z.int().min(0),
      removed: z.int().min(0),
      /** The file was dirty when the pass opened. */
      fromBeforePass: z.boolean(),
    }),
  ),
  foreignCommits: z.array(z.object({ sha: GitObjectName, subject: z.string() })),
  summary: z.string(),
  gate: PassCloseGate,
});
export type PassClosePreviewDto = z.infer<typeof PassClosePreviewDto>;

/** What the builder chose for an unfinished page at close. */
export const PassClosePageChoice = { TakeOut: 'take_out', SignOff: 'sign_off' } as const;
export type PassClosePageChoice = (typeof PassClosePageChoice)[keyof typeof PassClosePageChoice];

/**
 * `POST /passes/:passId/close`: the lists as confirmed. Pages set to Sign Off Now are signed off in
 * the order given; a file placed in a task lands as one more commit naming it, one left out stays in
 * the folder. Kept as the close's plan, so a restart runs the same close.
 */
export const PassCloseRequest = z.object({
  token: z.string().min(1),
  pages: z.array(z.object({ taskId: TaskId, choice: z.enum(PassClosePageChoice) })),
  files: z.array(z.object({ path: z.string().min(1), placeIn: TaskId.nullable() })),
  shared: z.array(SharedChoice),
});
export type PassCloseRequest = z.infer<typeof PassCloseRequest>;

/** What `POST /passes/:passId/close` answers: closing, or the lists again with what changed. */
export const PassCloseAnswerDto = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('closing'), pass: PassDto }),
  z.object({
    outcome: z.literal('changed'),
    preview: PassClosePreviewDto,
    /** What differs from the lists confirmed, one line each. */
    changed: z.array(z.string()),
  }),
]);
export type PassCloseAnswerDto = z.infer<typeof PassCloseAnswerDto>;

/**
 * What `POST /passes/:passId/close/continue` answers (202): the close of a closing pass whose job
 * stopped on an error goes on from its recorded step, on the plan it was confirmed with. Refused (409)
 * for a pass that is not closing.
 */
export const PassCloseContinueDto = z.object({ outcome: z.literal('closing'), pass: PassDto });
export type PassCloseContinueDto = z.infer<typeof PassCloseContinueDto>;
