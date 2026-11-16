import {
  BoardStatus,
  BuilderToolName,
  ChatToolInputs,
  ChatToolName,
  ChatTitleSource,
  ConflictError,
  ConversationState,
  cutTitle,
  EventType,
  DecisionId,
  InboxState,
  PermissionChoice,
  PrincipleId,
  QuestionCategory,
  TaskEditPrevious,
  type ChatToolResult,
  type InboxOption,
  type ProjectId,
  TaskId,
  type TaskDto,
} from '@10db/contracts';
import {
  chatMadeTask,
  chatView,
  getConversation,
  getDecision,
  getInboxItem,
  getPrinciple,
  getProject,
  recordChatTask,
  setChatTitle,
} from '@10db/db';
import type { Clock } from '../clock';
import type { EventBus, StateStore } from '../events';
import { ParkedError, type InboxService } from '../inbox';
import type { ChatToolHandlers, ChatToolsFor } from '../mcp';
import { z } from 'zod';
import type { Briefs } from './briefs';
import type { ChatLiveSessions } from './live-sessions';
import { chatGitTools, type ChatGitToolsDeps } from './git-tools';
import { CHAT_TOOL_POLICY, ChatToolPolicy } from './tool-policy';

// Sessions spec §6.6: a chat's tools. Each is the builder's own tool held to the chat's project.
// Removing a task the chat didn't file, and retiring, withdrawing or superseding a record, ask the
// builder on a card first; a filed task, an edit, a start and a rename answer a row the tab draws.

/** What the builder's MCP tools answer, by name, over the daemon's services. */
export type BuilderTools = Record<BuilderToolName, (args: unknown) => unknown>;

export interface ChatToolsDeps {
  readonly state: StateStore;
  readonly bus: Pick<EventBus, 'subscribe'>;
  readonly inbox: Pick<InboxService, 'ask' | 'withdraw'>;
  readonly clock: Clock;
  readonly live: ChatLiveSessions;
  readonly builder: BuilderTools;
  readonly getTask: (id: TaskId) => TaskDto;
  /** What the tools that change git in Your folder act through. */
  readonly gitTools: ChatGitToolsDeps;
  /** The briefs the chats' agents wrote for Do It. */
  readonly briefs: Briefs;
}

/** What a tool says when the builder kept their work. */
export const BUILDER_KEPT_TASK = 'The builder kept this task.';
export const BUILDER_KEPT_RECORD = 'The builder kept this record as it is.';
/** What a tool waiting on a card says once the turn was stopped or the session ended. */
export const BUILDER_STOPPED = 'The builder stopped the turn.';
/** What a tool says once its card waited out the project's human wait and was withdrawn. */
export const BUILDER_NO_ANSWER = 'The builder did not answer in time, so nothing changed.';

/** A card a chat's tool raises can be allowed once or denied. */
const ASK_OPTIONS: readonly InboxOption[] = [
  { label: PermissionChoice.AllowOnce, description: 'Allow this once' },
  { label: PermissionChoice.Deny, description: 'Deny; your note is passed to the agent' },
];

const BOARD_WORDS: Readonly<Record<BoardStatus, string>> = {
  [BoardStatus.Backlog]: 'Backlog',
  [BoardStatus.Ready]: 'Ready',
  [BoardStatus.InProgress]: 'In Progress',
  [BoardStatus.InReview]: 'In Review',
  [BoardStatus.Blocked]: 'Blocked',
  [BoardStatus.Done]: 'Done',
};

const EDITED_FIELDS = [
  'title',
  'headline',
  'why',
  'description',
  'acceptanceCriteria',
  'rigor',
  'kinds',
  'areas',
  'landing',
] as const;

/** What the builder's `create_task` answers: the filed task's summary. */
const FiledTask = z.object({ id: TaskId });

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The old value of each field an edit names and changes, for its Undo. */
function previousOf(before: TaskDto, edit: Record<string, unknown>): TaskEditPrevious {
  const previous: Record<string, unknown> = {};
  for (const field of EDITED_FIELDS) {
    if (!(field in edit) || edit[field] === undefined) continue;
    const old = before[field];
    const now = field === 'kinds' ? before.kinds.map((k) => ({ key: k.key })) : old;
    if (!same(now, edit[field])) previous[field] = old;
  }
  // A builder's edit of the kinds also moves the kinds they took off, so Undo puts those back too.
  if ('kinds' in previous) previous['kindsOff'] = before.kindsOff;
  return TaskEditPrevious.parse(previous);
}

/** The arguments as an object, with any project they name replaced by the chat's own. */
function inProject(args: unknown, projectId: ProjectId): Record<string, unknown> {
  const fields = typeof args === 'object' && args !== null ? { ...args } : {};
  return { ...fields, projectId };
}

export function createChatTools(deps: ChatToolsDeps): ChatToolsFor {
  const { state, builder } = deps;

  return (session): ChatToolHandlers => {
    const { projectId, chatId, conversationId, sessionId } = session;

    /** The task, when it is the chat's project's; any other is refused. */
    const ownTask = (taskId: TaskId): TaskDto => {
      const task = deps.getTask(taskId);
      if (task.projectId !== projectId)
        throw new ConflictError('That task is in another project; this chat works in its own.');
      return task;
    };
    /**
     * The record a knowledge tool names, as its card quotes it: its words and its id. A record of
     * another project is refused; one that holds everywhere (scope you) has no project and is the chat's too.
     */
    const named = (id: string): string => {
      const decision = DecisionId.safeParse(id);
      const record = decision.success
        ? getDecision(state.db, decision.data)
        : getPrinciple(state.db, PrincipleId.parse(id));
      if (record.projectId !== null && record.projectId !== projectId)
        throw new ConflictError('That record is in another project; this chat works in its own.');
      const text = 'statement' in record ? record.statement : `${record.question} ${record.choice}`;
      return `“${text}” (${id}).`;
    };
    const run = (name: BuilderToolName, args: unknown): Promise<unknown> =>
      Promise.resolve(builder[name](args));

    /**
     * Asks the builder on a card owned by the conversation; answers whether they allowed it. The card
     * waits the project's human wait, inside the call's own timeout of that wait plus 5 minutes
     * (`hooks.ts`), so it is withdrawn before the agent is told the call timed out and a late Allow
     * finds it closed.
     */
    const ask = async (
      title: string,
      body: string,
    ): Promise<'allow' | 'deny' | 'stopped' | 'timed_out'> => {
      const live = deps.live.get(conversationId, sessionId);
      if (live === null) return 'stopped';
      const waitMs = getProject(state.db, projectId).humanWaitMinutes * 60_000;
      const { item, answer } = deps.inbox.ask({
        workstreamId: null,
        conversationId,
        projectId,
        sessionId,
        kind: 'permission',
        title,
        body,
        options: ASK_OPTIONS,
        recommendation: null,
        category: QuestionCategory.Access,
        urgency: 'normal',
        detail: null,
        signal: live.signal,
      });
      let off: () => void = () => undefined;
      let settle: (why: 'stopped' | 'timed_out') => void = () => undefined;
      // A card withdrawn (a Stop, an archive, the wait passing) answers the call: nothing waits on it any
      // more. The first reason given wins.
      const withdrawn = new Promise<'stopped' | 'timed_out'>((resolve) => {
        settle = resolve;
        off = deps.bus.subscribe((event) => {
          if (event.entityId !== item.id) return;
          if (getInboxItem(state.db, item.id).state === InboxState.Cancelled) resolve('stopped');
        });
      });
      const deadline = deps.clock.setTimeout(() => {
        settle('timed_out');
        deps.inbox.withdraw(item.id);
      }, waitMs);
      try {
        live.observer.onWaitStart(item);
        const answered = await Promise.race([answer, withdrawn]);
        if (answered === 'stopped' || answered === 'timed_out') return answered;
        return answered.choice === PermissionChoice.AllowOnce ? 'allow' : 'deny';
      } catch (error) {
        if (error instanceof ParkedError) return 'stopped';
        throw error;
      } finally {
        deadline.cancel();
        off();
        live.observer.onWaitEnd(item);
      }
    };

    /** A tool that takes the builder's work away runs once they allow it. */
    const asked = async (
      title: string,
      body: string,
      kept: string,
      act: () => Promise<unknown>,
    ): Promise<unknown> => {
      const verdict = await ask(title, body);
      if (verdict === 'allow') return act();
      const notes = { deny: kept, stopped: BUILDER_STOPPED, timed_out: BUILDER_NO_ANSWER } as const;
      return { done: false, note: notes[verdict] };
    };

    const handlers: Record<ChatToolName, (input: unknown) => Promise<unknown>> = {
      [ChatToolName.ListProjects]: (args) => run(BuilderToolName.ListProjects, args),
      [ChatToolName.ListKinds]: (args) => run(BuilderToolName.ListKinds, args),
      [ChatToolName.ListTasks]: () => run(BuilderToolName.ListTasks, { projectId }),
      [ChatToolName.CreateTask]: async (args) => {
        const { id } = FiledTask.parse(
          await run(BuilderToolName.CreateTask, inProject(args, projectId)),
        );
        state.write((ctx) => {
          recordChatTask(ctx, chatId, id);
        });
        const task = deps.getTask(id);
        const result: ChatToolResult = {
          kind: 'task',
          taskId: id,
          title: task.title,
          column: BOARD_WORDS[task.boardStatus],
        };
        return result;
      },
      [ChatToolName.EditTask]: async (args) => {
        const edit = ChatToolInputs.edit_task.parse(args);
        const before = ownTask(edit.taskId);
        await run(BuilderToolName.EditTask, edit);
        const result: ChatToolResult = {
          kind: 'task_edit',
          taskId: before.id,
          title: deps.getTask(before.id).title,
          previous: previousOf(before, edit),
        };
        return result;
      },
      [ChatToolName.RemoveTask]: async (args) => {
        const { taskId } = ChatToolInputs.remove_task.parse(args);
        const task = ownTask(taskId);
        if (
          CHAT_TOOL_POLICY.remove_task === ChatToolPolicy.Asks &&
          !chatMadeTask(state.db, chatId, taskId)
        )
          return asked(
            `Remove “${task.title}”?`,
            'The chat asks to remove a task it did not file. Removing it takes it off the Board.',
            BUILDER_KEPT_TASK,
            () => run(BuilderToolName.RemoveTask, { taskId }),
          );
        return run(BuilderToolName.RemoveTask, { taskId });
      },
      [ChatToolName.StartTask]: async (args) => {
        const start = ChatToolInputs.start_task.parse(args);
        ownTask(start.taskId);
        await run(BuilderToolName.StartTask, start);
        const result: ChatToolResult = { kind: 'start', taskId: start.taskId, started: true };
        return result;
      },
      [ChatToolName.MoveTask]: (args) => {
        ownTask(ChatToolInputs.move_task.parse(args).taskId);
        return run(BuilderToolName.MoveTask, args);
      },
      [ChatToolName.RunNext]: (args) => {
        ownTask(ChatToolInputs.run_next.parse(args).taskId);
        return run(BuilderToolName.RunNext, args);
      },
      [ChatToolName.ListInbox]: (args) => run(BuilderToolName.ListInbox, args),
      [ChatToolName.StartShape]: (args) =>
        run(BuilderToolName.StartShape, inProject(args, projectId)),
      [ChatToolName.ImportPlan]: (args) =>
        run(BuilderToolName.ImportPlan, inProject(args, projectId)),
      [ChatToolName.SearchKnowledge]: (args) =>
        run(BuilderToolName.SearchKnowledge, inProject(args, projectId)),
      [ChatToolName.SaveDecision]: (args) =>
        run(BuilderToolName.SaveDecision, inProject(args, projectId)),
      [ChatToolName.SavePrinciple]: (args) =>
        run(BuilderToolName.SavePrinciple, inProject(args, projectId)),
      [ChatToolName.SupersedeKnowledge]: async (args) =>
        asked(
          'Change a recorded decision or principle?',
          `${named(ChatToolInputs.supersede_knowledge.parse(args).id)} The chat asks to supersede this record. The old one stays in history.`,
          BUILDER_KEPT_RECORD,
          () => run(BuilderToolName.SupersedeKnowledge, args),
        ),
      [ChatToolName.RetireKnowledge]: async (args) =>
        asked(
          'Retire a principle?',
          `${named(ChatToolInputs.retire_knowledge.parse(args).id)} The chat asks to retire this principle, which then stops applying anywhere.`,
          BUILDER_KEPT_RECORD,
          () => run(BuilderToolName.RetireKnowledge, args),
        ),
      [ChatToolName.WithdrawKnowledge]: async (args) =>
        asked(
          'Withdraw a recorded decision or principle?',
          `${named(ChatToolInputs.withdraw_knowledge.parse(args).id)} The chat asks to withdraw this record as a mistake.`,
          BUILDER_KEPT_RECORD,
          () => run(BuilderToolName.WithdrawKnowledge, args),
        ),
      [ChatToolName.ListProposals]: (args) =>
        run(BuilderToolName.ListProposals, inProject(args, projectId)),
      ...chatGitTools(deps.gitTools, session),
      [ChatToolName.WriteBrief]: (args) => {
        const brief = ChatToolInputs.write_brief.parse(args);
        // Only the chat's open session writes a brief, and not once Do It has sealed the chat.
        if (deps.live.get(conversationId, sessionId) === null)
          throw new ConflictError('This session has ended, so its brief is not kept.');
        if (getConversation(state.db, conversationId).state === ConversationState.Sealed)
          throw new ConflictError('This chat was handed to a task, so a brief is not kept.');
        deps.briefs.write(chatId, brief, sessionId);
        state.write((ctx) => {
          ctx.emit({
            type: EventType.ChatChanged,
            entityType: 'chat',
            entityId: chatId,
            data: { projectId },
          });
        });
        return Promise.resolve({ kept: true });
      },
      [ChatToolName.SetTitle]: (args) => {
        const title = cutTitle(ChatToolInputs.set_title.parse(args).title);
        const previousTitle = chatView(state.db, chatId).title;
        const renamed = state.write((ctx) =>
          setChatTitle(ctx, chatId, title, ChatTitleSource.Agent),
        );
        if (!renamed)
          return Promise.resolve({
            renamed: false,
            title: previousTitle,
            note: 'The builder named this session, so the name stays.',
          });
        const result: ChatToolResult = { kind: 'title', title, previousTitle };
        return Promise.resolve(result);
      },
    };
    return handlers;
  };
}
