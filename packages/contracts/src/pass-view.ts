import { z } from 'zod';
import { Title } from './entities';
import { ProposedArea } from './folders';
import { TaskId } from './ids';
import { PASS_PAGE_CAP_MAX, PassFileChange, PassTurnDto } from './passes';
import { TASK_MESSAGE_MAX_CHARS } from './task-thread';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §4.2, §4.3: what the
// Workbench reads before a pass opens, the pages it adds to one, and a page's turns.

const Timestamp = z.iso.datetime();

/** A task the builder sees by its title. */
const NamedTask = z.object({ taskId: TaskId, title: z.string() });

/** What the project lacks that Start Pass says above its button; none blocks the pass. */
export const PassLackKind = {
  /** The gate needs Docker and the project has it off. */
  DockerOff: 'docker_off',
  /** The folder's branch has commits the base lacks, which the pull request will carry. */
  AheadOfBase: 'ahead_of_base',
  /** No app address is set, so Open Page has nowhere to go. */
  NoAppUrl: 'no_app_url',
} as const;
export type PassLackKind = (typeof PassLackKind)[keyof typeof PassLackKind];

/** One page area as the picker lists it. */
export const PassStartPageDto = z.object({
  area: z.string().min(1),
  route: z.string().nullable(),
  /** When a file under the area last changed; null when none is in the repository yet. */
  lastChangedAt: Timestamp.nullable(),
  /** How many of its files are changed in the folder and would be part of the page's work. */
  uncommitted: z.int().min(0),
  /** The task that holds the page now; a page taken by a pass waits for it. */
  heldBy: NamedTask.nullable(),
});
export type PassStartPageDto = z.infer<typeof PassStartPageDto>;

export const PassLackDto = z.object({
  kind: z.enum(PassLackKind),
  /** The commits ahead, for `ahead_of_base`. */
  count: z.int().min(0).nullable(),
  /** The folder's branch, for `ahead_of_base`. */
  branch: z.string().nullable(),
});
export type PassLackDto = z.infer<typeof PassLackDto>;

/** `GET /projects/:projectId/pass-start`: the picker's pages and what Start Pass says. */
export const PassStartDto = z.object({
  pages: z.array(PassStartPageDto),
  /** Changed files in shared areas and elsewhere: they stay as they are. */
  otherUncommitted: z.int().min(0),
  lacks: z.array(PassLackDto),
  /** Why a pass cannot open now (an unfinished shared batch, a lane in the folder, a detached HEAD). */
  refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type PassStartDto = z.infer<typeof PassStartDto>;

/** `POST /passes/:passId/pages`: Add Page. New tasks for `pages`, and open tasks joining. */
export const PassJoinRequest = z
  .object({
    pages: z.array(z.string().min(1)).max(PASS_PAGE_CAP_MAX),
    taskIds: z.array(TaskId).max(PASS_PAGE_CAP_MAX),
    firstMessage: z.string().min(1).max(TASK_MESSAGE_MAX_CHARS).nullable(),
  })
  .refine((join) => join.pages.length + join.taskIds.length > 0, {
    message: 'Add at least one page or task',
  });
export type PassJoinRequest = z.infer<typeof PassJoinRequest>;

/** `PATCH /passes/:passId`. */
export const PassRename = z.object({ name: Title });
export type PassRename = z.infer<typeof PassRename>;

/** `POST /projects/:projectId/propose-page-areas`: page areas to add, and the ones left out with why. */
export const PagesProposalDto = z.object({
  pages: z.array(ProposedArea),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
});
export type PagesProposalDto = z.infer<typeof PagesProposalDto>;

/** `GET /goals/:goalId/pass-pages`: the page areas a goal's tasks committed in, and those tasks. */
export const GoalPassPagesDto = z.object({
  pages: z.array(z.string()),
  fromTasks: z.array(TaskId),
});
export type GoalPassPagesDto = z.infer<typeof GoalPassPagesDto>;

/** `GET /tasks/:taskId/turns`: a turn with the files it changed against the previous kept commit. */
export const PassTurnWithFilesDto = PassTurnDto.extend({ files: z.array(PassFileChange) });
export type PassTurnWithFilesDto = z.infer<typeof PassTurnWithFilesDto>;
