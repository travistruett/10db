import {
  InboxState,
  isParkChoice,
  SharedAskDetail,
  QuestionCategory,
  SHARED_ASK_ALLOW_CHOICE,
  SHARED_ASK_KEEP_CHOICE,
  SHARED_ASK_REPLY_CHOICE,
  sharedAskFoldKey,
  Urgency,
  type InboxAnswer,
  type InboxItemId,
  type PassHoldDto,
  type PassSharedChangeDto,
  type SessionId,
  type TaskId,
  type TaskMessageId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getInboxItem,
  getTask,
  getWorkstreamRow,
  insertBuilderMessage,
  insertSystemNotice,
  listHolds,
  listSharedChanges,
  markTaskMessagesDelivered,
  markTaskMessagesPushed,
  openItemsForWorkstream,
  openPassTurn,
  passHoldingTask,
} from '@10db/db';
import type { InboxService } from '../inbox';
import type { SharedDeps } from './shared-hold';

// Workbench spec §7.2 step 3 (W5): before a second task of a pass changes a shared area another task
// changed during the pass or holds now, the daemon asks the builder in the task's thread, and the
// agent's request_claim waits for the answer.

/** Another task's part in a shared area, as the question names it. */
export interface SharedAskOther {
  readonly taskId: TaskId;
  /** The shared files it changed and did not drop; empty while it only holds the area. */
  readonly paths: readonly string[];
  /** When it last changed the area, or null while it only holds it. */
  readonly at: string | null;
  readonly holdsNow: boolean;
}

/**
 * Each other task of the pass that changed `area` during the pass, by a change not dropped, or holds
 * it now, in the order they first did. Pure: the holds and changes are the pass's rows.
 */
export function sharedAskOthers(input: {
  readonly taskId: TaskId;
  readonly area: string;
  readonly holds: readonly Pick<PassHoldDto, 'taskId' | 'area' | 'seq' | 'closedAt'>[];
  readonly changes: readonly Pick<
    PassSharedChangeDto,
    'seq' | 'taskId' | 'paths' | 'dropOf' | 'droppedBy' | 'updatedAt'
  >[];
}): SharedAskOther[] {
  const inArea = new Set(input.holds.filter((h) => h.area === input.area).map((h) => h.seq));
  const others = new Map<TaskId, { paths: Set<string>; at: string | null; holdsNow: boolean }>();
  const of = (taskId: TaskId) => {
    const found = others.get(taskId) ?? { paths: new Set<string>(), at: null, holdsNow: false };
    others.set(taskId, found);
    return found;
  };
  for (const hold of input.holds)
    if (hold.area === input.area && hold.taskId !== input.taskId && hold.closedAt === null)
      of(hold.taskId).holdsNow = true;
  for (const change of input.changes) {
    if (!inArea.has(change.seq) || change.taskId === input.taskId) continue;
    if (change.dropOf !== null || change.droppedBy !== null || change.paths.length === 0) continue;
    const other = of(change.taskId);
    for (const path of change.paths) other.paths.add(path);
    if (other.at === null || other.at < change.updatedAt) other.at = change.updatedAt;
  }
  return [...others].map(([taskId, o]) => ({
    taskId,
    paths: [...o.paths].sort(),
    at: o.at,
    holdsNow: o.holdsNow,
  }));
}

/** Whether a task asking for a shared area asks the builder first (spec §7.2 step 3). Pure. */
export function sharedAskNeeded(input: Parameters<typeof sharedAskOthers>[0]): boolean {
  return sharedAskOthers(input).length > 0;
}

/** How the builder answered: the claim goes on, or the agent is told what to do instead. */
export type SharedAnswer =
  { readonly allowed: true } | { readonly allowed: false; readonly instruction: string };

const quoted = (paths: readonly string[]): string => paths.map((p) => `\`${p}\``).join(', ');

/** "12 minutes ago", from `at` to `now`. */
function ago(at: string, now: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
}

/** What the agent is told when the builder keeps the change to its page. */
const keepInstruction = (area: string, note?: string): string =>
  `The builder answered ${SHARED_ASK_KEEP_CHOICE}: you did not get shared area ${area}. Keep this change inside your page and edit nothing in ${area}; carry on with your page's files.${
    note !== undefined && note.trim() !== '' ? ` The builder added: "${note.trim()}"` : ''
  }`;

/**
 * Asks the builder before the task changes shared `area` (spec §7.2 step 3), when another task of
 * the pass changed it or holds it; null when nobody did. The question, on the task, folds by task
 * and area, and offers Allow, Keep It to This Page and a reply. Its answer: Allow lets the claim go
 * on; Keep It to This Page tells the agent to keep the change inside its page; a reply is the
 * builder's words, written to the thread as a message the answer delivers, and the claim is not
 * given; Park the task answers as Keep and the thread says so. The answer rejects, and the question
 * is withdrawn, when the session stops waiting.
 */
export function askShared(
  deps: SharedDeps & {
    readonly inbox: InboxService;
    /** Hands a builder message to the page's session, starting a turn when none is open. */
    readonly deliver?: (taskId: TaskId, messageId: TaskMessageId) => Promise<void>;
  },
  input: {
    readonly workstreamId: WorkstreamId;
    readonly sessionId: SessionId;
    readonly area: string;
    readonly reason: string;
    readonly signal: AbortSignal;
  },
): { readonly inboxId: InboxItemId; readonly answer: Promise<SharedAnswer> } | null {
  const db = deps.state.db;
  const task = getTask(db, getWorkstreamRow(db, input.workstreamId).taskId);
  const pass = passHoldingTask(db, task);
  if (!pass) return null;
  const others = sharedAskOthers({
    taskId: task.id,
    area: input.area,
    holds: listHolds(db, pass.id),
    changes: listSharedChanges(db, pass.id),
  });
  if (others.length === 0) return null;
  const now = deps.state.now();
  const named = others.map((o) => ({ ...o, title: getTask(db, o.taskId).title }));
  const lines = named.map((o) =>
    o.paths.length > 0 && o.at !== null
      ? `${o.title} changed ${quoted(o.paths)} there ${ago(o.at, now)}${o.holdsNow ? ', and holds it now' : ''}.`
      : `${o.title} holds it now.`,
  );
  const detail: SharedAskDetail = {
    kind: 'shared_ask',
    passId: pass.id,
    taskId: task.id,
    workstreamId: input.workstreamId,
    area: input.area,
    others: named.map((o) => ({
      taskId: o.taskId,
      title: o.title,
      paths: [...o.paths],
      at: o.at,
      holdsNow: o.holdsNow,
    })),
  };
  const { item, answer } = deps.inbox.ask({
    projectId: pass.projectId,
    workstreamId: input.workstreamId,
    sessionId: input.sessionId,
    kind: 'question',
    title: `${task.title} wants to change shared code in ${input.area}`,
    body: [...lines, `Reason given: ${input.reason}`].join('\n'),
    options: [
      {
        label: SHARED_ASK_ALLOW_CHOICE,
        description: `This change is for every page: ${task.title} gets ${input.area} for its turn`,
      },
      {
        label: SHARED_ASK_KEEP_CHOICE,
        description: `The agent keeps the change inside its own page and leaves ${input.area} alone`,
      },
      {
        label: SHARED_ASK_REPLY_CHOICE,
        description: 'Your note goes to the agent instead, and it does not get the area',
      },
    ],
    recommendation: null,
    category: QuestionCategory.Other,
    urgency: Urgency.High,
    detail,
    signal: input.signal,
    foldKey: sharedAskFoldKey(input.workstreamId, input.area),
  });
  const answered = answer.then(
    (given) => answerOf(deps, { taskId: task.id, area: input.area }, given),
    (error: unknown) => {
      // The asking session stopped: nobody waits for this question any more.
      if (getInboxItem(deps.state.db, item.id).state === InboxState.Open)
        deps.inbox.withdraw(item.id);
      throw error;
    },
  );
  answered.catch(() => undefined);
  return { inboxId: item.id, answer: answered };
}

/** What the builder's answer means for the call, with the thread's line for a reply or a park. */
function answerOf(
  deps: SharedDeps & {
    readonly deliver?: (taskId: TaskId, messageId: TaskMessageId) => Promise<void>;
  },
  input: { readonly taskId: TaskId; readonly area: string },
  given: InboxAnswer,
): SharedAnswer {
  if (given.choice === SHARED_ASK_ALLOW_CHOICE) return { allowed: true };
  if (isParkChoice(given.choice)) {
    deps.state.write((ctx) => {
      insertSystemNotice(
        ctx,
        input.taskId,
        `The question about shared ${input.area} was answered with Park the task, which in a pass keeps the change to this page: the page stays in the pass.`,
      );
    });
    return { allowed: false, instruction: keepInstruction(input.area) };
  }
  if (given.choice === SHARED_ASK_REPLY_CHOICE) {
    const words = (given.note ?? '').trim();
    // While the turn is open the call's answer hands the words to the agent, so the message is
    // delivered with it; once the turn has ended nobody reads that answer, and the message starts
    // the page's next turn as the builder's own would.
    const waiting = deps.state.write((ctx) => {
      const message = insertBuilderMessage(ctx, input.taskId, { body: words, files: [] });
      if (!openPassTurn(ctx.tx, input.taskId)) return message.id;
      markTaskMessagesPushed(ctx, [message.id]);
      markTaskMessagesDelivered(ctx, input.taskId, [message.id]);
      return null;
    });
    if (waiting !== null) void deps.deliver?.(input.taskId, waiting).catch(() => undefined);
    return {
      allowed: false,
      instruction: `The builder replied instead of giving you shared area ${input.area}: "${words}". You did not get ${input.area}; edit nothing there, and do what the reply says.`,
    };
  }
  return { allowed: false, instruction: keepInstruction(input.area, given.note) };
}

/**
 * Withdraws the workstream's open shared-area questions (spec §6.2 step 2): its turn has ended, and
 * an area is held only for a turn, so an answer to one would grant nothing.
 */
export function withdrawSharedAsks(
  deps: Pick<SharedDeps, 'state'> & { readonly inbox: InboxService },
  workstreamId: WorkstreamId,
): void {
  for (const item of openItemsForWorkstream(deps.state.db, workstreamId))
    if (item.state === InboxState.Open && SharedAskDetail.safeParse(item.detail).success)
      deps.inbox.withdraw(item.id);
}
