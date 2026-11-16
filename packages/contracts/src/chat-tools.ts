import { z } from 'zod';
import { BuilderToolInputs, BuilderToolName } from './builder-mcp-tools';
import { TaskPatchFields } from './entities';
import { TaskId } from './ids';
import { TaskLanding } from './landing';
import { StartShapeInput } from './shape-files';
import { TASK_MESSAGE_MAX_CHARS } from './task-thread';

// Sessions spec §6.6: a chat's agent reaches every builder tool through 10db's own server, held to the
// chat's project, plus `set_title`. What each returns for a row the screen draws is `ChatToolResult`.

/** The tools that change git in Your folder, which a chat reaches only through the daemon. */
export const ChatGitToolName = {
  MakeBranch: 'make_branch',
  SwitchBranch: 'switch_branch',
  Pull: 'pull',
  CommitChanges: 'commit_changes',
  PushBranch: 'push_branch',
  OpenPullRequest: 'open_pull_request',
  MergePullRequest: 'merge_pull_request',
} as const;

export const ChatToolName = {
  ...BuilderToolName,
  SetTitle: 'set_title',
  ...ChatGitToolName,
} as const;
export type ChatToolName = (typeof ChatToolName)[keyof typeof ChatToolName];

/** The most characters a chat's title keeps, cut at a word (UI spec §5.4). */
export const CHAT_TITLE_MAX = 28;

/** The most areas and acceptance criteria a brief names. */
export const BRIEF_LIST_MAX = 8;

/** What the chat's agent writes for Do It: the task's title, brief, areas and acceptance criteria. */
export const WriteBriefInput = z.object({
  title: z.string().trim().min(1).max(200),
  brief: z.string().trim().min(1).max(TASK_MESSAGE_MAX_CHARS),
  areas: z.array(z.string().min(1).max(100)).max(BRIEF_LIST_MAX).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(BRIEF_LIST_MAX).optional(),
});
export type WriteBriefInput = z.infer<typeof WriteBriefInput>;

/** The builder tools' inputs with the project left out: a chat's tools act in its own project. */
export const ChatToolInputs = {
  [ChatToolName.ListProjects]: BuilderToolInputs.list_projects,
  [ChatToolName.ListKinds]: BuilderToolInputs.list_kinds,
  [ChatToolName.ListTasks]: z.object({}),
  [ChatToolName.CreateTask]: BuilderToolInputs.create_task.omit({ projectId: true }),
  [ChatToolName.EditTask]: BuilderToolInputs.edit_task,
  [ChatToolName.RemoveTask]: BuilderToolInputs.remove_task,
  [ChatToolName.StartTask]: BuilderToolInputs.start_task,
  [ChatToolName.MoveTask]: BuilderToolInputs.move_task,
  [ChatToolName.RunNext]: BuilderToolInputs.run_next,
  [ChatToolName.ListInbox]: BuilderToolInputs.list_inbox,
  // Its refinements are checked again with the project added, by the builder tool's own parse.
  [ChatToolName.StartShape]: z.object(StartShapeInput.shape).omit({ projectId: true }),
  [ChatToolName.ImportPlan]: BuilderToolInputs.import_plan.omit({ projectId: true }),
  [ChatToolName.SearchKnowledge]: BuilderToolInputs.search_knowledge.omit({ projectId: true }),
  [ChatToolName.SaveDecision]: BuilderToolInputs.save_decision.omit({ projectId: true }),
  [ChatToolName.SavePrinciple]: BuilderToolInputs.save_principle.omit({ projectId: true }),
  [ChatToolName.SupersedeKnowledge]: BuilderToolInputs.supersede_knowledge,
  [ChatToolName.RetireKnowledge]: BuilderToolInputs.retire_knowledge,
  [ChatToolName.WithdrawKnowledge]: BuilderToolInputs.withdraw_knowledge,
  [ChatToolName.ListProposals]: BuilderToolInputs.list_proposals.omit({ projectId: true }),
  [ChatToolName.SetTitle]: z.object({ title: z.string().trim().min(1).max(80) }),
  [ChatToolName.MakeBranch]: z.object({ name: z.string().min(1).max(200) }),
  [ChatToolName.SwitchBranch]: z.object({ name: z.string().min(1).max(200) }),
  [ChatToolName.Pull]: z.object({}),
  [ChatToolName.CommitChanges]: z.object({
    message: z.string().trim().min(1).max(20_000),
    paths: z.array(z.string().min(1).max(1024)).min(1).max(500).optional(),
  }),
  [ChatToolName.PushBranch]: z.object({}),
  [ChatToolName.OpenPullRequest]: z.object({
    title: z.string().trim().min(1).max(256),
    body: z.string().max(60_000),
    base: z.string().min(1).max(200).optional(),
  }),
  [ChatToolName.MergePullRequest]: z.object({ number: z.number().int().positive() }),
} as const satisfies Record<ChatToolName, z.ZodType>;

/** The old value of each field an `edit_task` changed, which its Undo patches back. */
export const TaskEditPrevious = TaskPatchFields.extend({ landing: TaskLanding }).partial();
export type TaskEditPrevious = z.infer<typeof TaskEditPrevious>;

/** What a chat tool returns for a row the screen draws: a filed task, an edit, a start, a rename. */
export const ChatToolResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), taskId: TaskId, title: z.string(), column: z.string() }),
  z.object({
    kind: z.literal('task_edit'),
    taskId: TaskId,
    title: z.string(),
    previous: TaskEditPrevious,
  }),
  z.object({ kind: z.literal('title'), title: z.string(), previousTitle: z.string() }),
  z.object({ kind: z.literal('start'), taskId: TaskId, started: z.literal(true) }),
]);
export type ChatToolResult = z.infer<typeof ChatToolResult>;

/**
 * A title cut at the last word that fits in `max`, with no trailing period or space; one word longer
 * than `max` is cut at `max`. Counted in graphemes, so a cut never splits a character.
 */
export function cutTitle(title: string, max: number = CHAT_TITLE_MAX): string {
  const tidy = (s: string): string => s.replace(/[\s.]+$/u, '');
  const chars = Array.from(
    new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(
      title.trim().replace(/\s+/gu, ' '),
    ),
    (s) => s.segment,
  );
  if (chars.length <= max) return tidy(chars.join(''));
  const head = chars.slice(0, max).join('');
  if (chars[max] === ' ') return tidy(head);
  const space = head.lastIndexOf(' ');
  return tidy(space > 0 ? head.slice(0, space) : head);
}
