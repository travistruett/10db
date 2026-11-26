import {
  Approval,
  ConflictError,
  InboxKind,
  InboxState,
  NotFoundError,
  PrecedentScope,
  PrecedentState,
  SkipKind,
  SkipSource,
  SkippedActionId,
  TaskStatus,
  WORKSTREAM_FAILED_TITLE_PREFIX,
  WorkstreamId,
  WorkstreamState,
  type InboxAnswer,
  type InboxItemDto,
  type InboxItemId,
  type InboxOption,
  type ProjectId,
  type SkippedActionDto,
  type TaskDto,
  Urgency,
} from '@10db/contracts';
import {
  approvePrecedent,
  approveSkips,
  isLocalCopy,
  getTask,
  getWorkstreamRow,
  insertSkipFollowUp,
  insertTask,
  listInbox,
  openItemsForWorkstream,
  skipFollowUpOf,
  lastConfigHead,
  lastListed,
  passHoldingTask,
  listSkipsForWorkstream,
  markListed,
  unlistedEndedRuns,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { coverageLinesOf, coverageSection } from '../evals';
import { flagCard, rewordCard, BY_ANSWER, CardTier, type InboxService } from '../inbox';
import type { Logger } from '../log';
import { defaultPrecedentKind, LIMITS, writtenConfig } from '../trust';
import { checkoutOf } from './checkout';
import { followUpStart } from './follow-up-start';
import { sourceStateOf } from './skip-follow-up';

// Trust line §5: when an unattended run ends, one Inbox item lists what it skipped, the questions it
// was answered at once and the config it wrote, each once. It is marked in
// `skip_listings` in its own write, so a crash or a retry neither loses it nor repeats it.

/** The item's detail key: the run it lists. Its `skipIds` are the approvable skips it showed. */
export const SKIPPED_DETAIL = 'skippedRun';
/** The detail key set when the item lists config the run wrote. */
const CONFIG_DETAIL = 'listsConfig';

/** The answers the item offers; the card shows them as written. */
export const SkippedChoice = {
  RunTheseNow: 'Run these now',
  RunAndMakeRoutine: 'Run and Make Routine',
  Dismiss: 'Dismiss',
} as const;
export type SkippedChoice = (typeof SkippedChoice)[keyof typeof SkippedChoice];

/** Told each kind of command Run and Make Routine made a standing approval, inside the answer's write. */
export type MadeRoutine = (kind: { programKey: string; scope: PrecedentScope }) => void;

export interface SkippedCardDeps {
  readonly state: StateStore;
  readonly git: Pick<Git, 'changedFilesSince' | 'head'>;
  readonly log: Logger;
}

/** What clears a skip no follow-up can run, in the builder's words. */
function clearedBy(kind: SkipKind): string {
  switch (kind) {
    case SkipKind.DockerOff:
      return 'turn Docker on in Settings › Sandbox';
    case SkipKind.SecretRead:
      return 'turn on Agents may read .env files';
    case SkipKind.UnreadHazard:
    case SkipKind.HazardCard:
      return 'write it plainly or claim it';
    case SkipKind.EditorConfigWrite:
    case SkipKind.HomeRcWrite:
      return 'make the change yourself';
    case SkipKind.SafetyCheck:
      return 'only you can run it';
    case SkipKind.CantRunInLane:
      return "can't run in a lane: its program is outside what lanes may read. Use 10db's browser, or run it yourself";
    case SkipKind.MonitorNoCommand:
    case SkipKind.UnreadEditPath:
      return 'the agent can write it another way';
    case SkipKind.WebOrMcp:
    case SkipKind.UnknownTool:
    case SkipKind.MonitorSocket:
    case SkipKind.ReadOutside:
    case SkipKind.ConfigWrite:
    case SkipKind.EndlessLoop:
    case SkipKind.PassGit:
    case SkipKind.Deploy:
    case SkipKind.Escalation:
    case SkipKind.DefaultModeCard:
    case SkipKind.Classifier:
    case SkipKind.Host:
    case SkipKind.Question:
      // An approvable kind lands here only when its summary was cut: the builder never saw it whole.
      return 'it was too long to show whole, so run it yourself';
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** Agent-written text as one line of the item: a newline can't start a line of its own. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const named = (skip: SkippedActionDto): string =>
  oneLine(skip.kind === SkipKind.Host ? `reach ${skip.summary}` : skip.summary);

/** The item's body, every row shown. `config` is null when the run's changed paths couldn't be read. */
/** A card body with the eval suites the run's change touched closing it. */
function withEvals(db: DbReader, workstreamId: WorkstreamId, body: string): string {
  return [body, ...coverageSection(coverageLinesOf(db, workstreamId))].join('\n');
}

function bodyOf(skips: readonly SkippedActionDto[], config: readonly string[] | null): string {
  const asked = skips.filter((s) => s.kind === SkipKind.Question);
  const skipped = skips.filter((s) => s.kind !== SkipKind.Question);
  const approvable = skipped.filter((s) => s.approval !== Approval.None);
  const not = skipped.filter((s) => s.approval === Approval.None);
  const lines: string[] = [];
  if (approvable.length > 0) {
    const n = approvable.length;
    lines.push(
      `10db skipped ${String(n)} ${n === 1 ? 'call' : 'calls'} this task would have needed you for:`,
    );
    for (const s of approvable)
      lines.push(`- ${named(s)} (${s.limit === null ? oneLine(s.reason) : LIMITS[s.limit].label})`);
  }
  if (not.length > 0) {
    lines.push('', 'Skipped, and not something a follow-up can run:');
    for (const s of not) lines.push(`- ${named(s)}: ${clearedBy(s.kind)}`);
  }
  if (asked.length > 0) {
    lines.push('', 'Questions it would have asked:');
    for (const s of asked) lines.push(`- ${oneLine(s.summary)}`);
  }
  if (config === null) lines.push('', "10db couldn't read which config files this task changed.");
  else if (config.length > 0) {
    lines.push('', 'Config this task wrote, which runs only after you approve it:');
    for (const path of config) lines.push(`- ${oneLine(path)}`);
  }
  return lines.join('\n').replace(/^\n+/, '');
}

const DISMISS: InboxOption = {
  label: SkippedChoice.Dismiss,
  description: 'Leave the work as it is',
};

/** Run these now, worded by whether the follow-up would start now or wait for the source to ship. */
function runOption(waits: boolean): InboxOption {
  return {
    label: SkippedChoice.RunTheseNow,
    description: waits
      ? 'Waits for the task to finish shipping, then starts a follow-up that runs the calls above, approved'
      : 'Start a follow-up task that runs the calls above, approved',
  };
}

/**
 * Whether every skip a follow-up would run is 10db's judge's doubt: no limit named and a program key. Only then is
 * Run and Make Routine offered, since a kind is approved from its skips, and a skip that names a limit never makes
 * one.
 */
function makesRoutine(skips: readonly SkippedActionDto[]): boolean {
  return (
    skips.length > 0 &&
    skips.every(
      (s) => s.source === SkipSource.TendbJudge && s.limit === null && s.programKey !== null,
    )
  );
}

/** The skips of a run a follow-up can run approved. */
const approvableOf = (skips: readonly SkippedActionDto[]): SkippedActionDto[] =>
  skips.filter((s) => s.kind !== SkipKind.Question && s.approval !== Approval.None);

/** Run and Make Routine: Run these now, and a standing approval for the kind of each call it runs. */
const ROUTINE_OPTION: InboxOption = {
  label: SkippedChoice.RunAndMakeRoutine,
  description:
    'Run the calls above, approved, and treat each kind of command as routine in this project from now on',
};

/** The options that run a run's skips: Run these now, and Run and Make Routine where every skip allows it. */
function runOptions(skips: readonly SkippedActionDto[], waits: boolean): InboxOption[] {
  return approvableOf(skips).length === 0
    ? []
    : [runOption(waits), ...(makesRoutine(approvableOf(skips)) ? [ROUTINE_OPTION] : [])];
}

/**
 * The paths the run changed since `since` (its base when null), as the review step reads them, and
 * the commit they were read through; null when they can't be read.
 */
async function changedPaths(
  deps: SkippedCardDeps,
  workstreamId: WorkstreamId,
  since: string | null,
): Promise<{ readonly paths: string[]; readonly head: string } | null> {
  const db = deps.state.db;
  const row = getWorkstreamRow(db, workstreamId);
  const from = since ?? row.baseHead;
  if (from === null) return null;
  try {
    const checkout = checkoutOf(db, row);
    // Read first: a commit after it is read again by the next check, never skipped.
    const head = await deps.git.head(checkout);
    return { paths: await deps.git.changedFilesSince(checkout, from), head };
  } catch (error) {
    deps.log.warn(
      { workstreamId, err: error instanceof Error ? error.message : String(error) },
      "the run's changed paths could not be read for its skipped item",
    );
    return null;
  }
}

/**
 * Raises the item for an ended unattended run with something no earlier item of it listed, and marks
 * the run checked either way. A cancelled, running or pass run raises none.
 */
export async function raiseSkippedCard(
  deps: SkippedCardDeps,
  workstreamId: WorkstreamId,
): Promise<void> {
  const db = deps.state.db;
  const row = getWorkstreamRow(db, workstreamId);
  if (row.state !== WorkstreamState.Done && row.state !== WorkstreamState.Failed) return;
  const last = lastListed(db, workstreamId);
  const pass = passHoldingTask(db, getTask(db, row.taskId)) !== undefined;
  const skips = pass ? [] : listSkipsForWorkstream(db, workstreamId, last ?? undefined);
  // Each ending lists the config changed since the last check that read it; a pass lists none.
  const config = pass
    ? { paths: [], head: null }
    : await changedPaths(deps, workstreamId, lastConfigHead(db, workstreamId));
  const written = config === null ? null : writtenConfig(config.paths);
  const configHead = config?.head ?? null;
  const through = skips.at(-1)?.id ?? last ?? null;
  deps.state.write((ctx: WriteContext) => {
    // Another check of the run got here first while the paths were read.
    if (lastListed(ctx.tx, workstreamId) !== last) return;
    if (skips.length === 0 && (written === null || written.length === 0)) {
      markListed(ctx, workstreamId, through, null, configHead);
      return;
    }
    const task = getTask(ctx.tx, row.taskId);
    // Config git couldn't list is unknown, not written: such a card still closes with its task.
    const listsConfig = written !== null && written.length > 0;
    // A finished task's skipped calls are in its drawer, which offers Run These Now; only config it
    // wrote, which waits on the builder's approval, still needs a card.
    if (task.status !== TaskStatus.Open && !listsConfig) {
      markListed(ctx, workstreamId, through, null, configHead);
      return;
    }
    const skipIds = skips
      .filter((s) => s.kind !== SkipKind.Question && s.approval !== Approval.None)
      .map((s) => s.id);
    // A failed run already shows its builder a card: the skipped calls go on that one.
    const failed =
      row.state === WorkstreamState.Failed
        ? openItemsForWorkstream(ctx.tx, workstreamId).find(
            (i) =>
              i.kind === InboxKind.Flag &&
              i.state === InboxState.Open &&
              i.title.startsWith(WORKSTREAM_FAILED_TITLE_PREFIX),
          )
        : undefined;
    if (failed !== undefined) {
<<<<<<< b3003c46b579f0b8b49cafaf87d7445072e14948
      rewordCard(ctx, failed.id, `${failed.body}\n\n${bodyOf(skips, written)}`, {
        // Closing itself adds to the card; the builder can still dismiss a notice they have read.
        options: [
          ...failed.options.filter(
            (o) => o.label !== DISMISS.label && o.label !== ROUTINE_OPTION.label,
          ),
          ...(skipIds.length === 0
            ? []
            : runOptions(
                skips,
                followUpStart(sourceStateOf(ctx.tx, workstreamId)).kind === 'wait',
              )),
          DISMISS,
        ],
        detail: { ...failed.detail, [SKIPPED_DETAIL]: workstreamId, skipIds },
      });
||||||| ff4c17a6c
      rewordCard(ctx, failed.id, `${failed.body}\n\n${bodyOf(skips, written)}`, {
        // Closing itself adds to the card; the builder can still dismiss a notice they have read.
        options: [
          ...failed.options.filter((o) => o.label !== DISMISS.label),
          ...(skipIds.length === 0
            ? []
            : [runOption(followUpStart(sourceStateOf(ctx.tx, workstreamId)).kind === 'wait')]),
          DISMISS,
        ],
        detail: { ...failed.detail, [SKIPPED_DETAIL]: workstreamId, skipIds },
      });
=======
      rewordCard(
        ctx,
        failed.id,
        `${failed.body}\n\n${withEvals(ctx.tx, workstreamId, bodyOf(skips, written))}`,
        {
          // Closing itself adds to the card; the builder can still dismiss a notice they have read.
          options: [
            ...failed.options.filter((o) => o.label !== DISMISS.label),
            ...(skipIds.length === 0
              ? []
              : [runOption(followUpStart(sourceStateOf(ctx.tx, workstreamId)).kind === 'wait')]),
            DISMISS,
          ],
          detail: { ...failed.detail, [SKIPPED_DETAIL]: workstreamId, skipIds },
        },
      );
>>>>>>> 4edfb74ace0012666cd5740d83d575d05e00528a
      markListed(ctx, workstreamId, through, failed.id, configHead);
      return;
    }
    const item = flagCard(ctx, {
      projectId: row.projectId,
      workstreamId: null,
      tier: CardTier.Ask,
      urgency: Urgency.Normal,
      closesWhen: BY_ANSWER,
      title: `Skipped while you were away: ${task.title}`,
      body: withEvals(ctx.tx, workstreamId, bodyOf(skips, written)),
      options:
        skipIds.length === 0
          ? [DISMISS]
          : [
              ...runOptions(
                skips,
                followUpStart(sourceStateOf(ctx.tx, workstreamId)).kind === 'wait',
              ),
              DISMISS,
            ],
      recommendation: null,
      detail: {
        [SKIPPED_DETAIL]: workstreamId,
        skipIds,
        ...(listsConfig ? { [CONFIG_DETAIL]: true } : {}),
      },
      foldKey: `skipped:${workstreamId}:${through ?? 'none'}:${configHead ?? 'none'}`,
    });
    markListed(ctx, workstreamId, through, item.id, configHead);
  });
}

/** Raises the item of every ended run a crash or a restart left unchecked; runs after recovery. */
export async function sweepUnlistedRuns(deps: SkippedCardDeps): Promise<void> {
  for (const id of unlistedEndedRuns(deps.state.db)) {
    try {
      await raiseSkippedCard(deps, id);
    } catch (error) {
      deps.log.warn(
        { workstreamId: id, err: error instanceof Error ? error.message : String(error) },
        'the skipped item of an ended run could not be raised',
      );
    }
  }
}

/**
 * Closes every open item of a run whose task has finished or been abandoned, which a later run of the
 * task finishing makes it: the calls it lists are in the task's drawer, which offers Run These Now. An
 * item of a finished task that lists config the run wrote stays, since that config waits on the
 * builder's approval. Returns how many it closed.
 */
export function closeFinishedSkippedCards(
  db: DbReader,
  inbox: Pick<InboxService, 'resolve'>,
): number {
  let closed = 0;
  for (const item of listInbox(db, { states: [InboxState.Open] })) {
    if (item.kind !== InboxKind.Flag) continue;
    // The detail is JSON read back from the database: a boundary, so parse it.
    const run = WorkstreamId.safeParse(item.detail?.[SKIPPED_DETAIL]);
    if (!run.success) continue;
    let status: TaskStatus;
    try {
      status = getTask(db, getWorkstreamRow(db, run.data).taskId).status;
    } catch (error) {
      // A run or task no longer stored leaves nothing to act on.
      if (!(error instanceof NotFoundError)) throw error;
      status = TaskStatus.Cancelled;
    }
    if (status === TaskStatus.Open) continue;
    if (status === TaskStatus.Done && item.detail?.[CONFIG_DETAIL] === true) continue;
    inbox.resolve(
      item.id,
      status === TaskStatus.Done ? 'The task is done.' : 'The task was abandoned.',
    );
    closed += 1;
  }
  return closed;
}

const SkippedDetail = z.object({
  [SKIPPED_DETAIL]: WorkstreamId,
  skipIds: z.array(SkippedActionId),
});

/** The most of a skip's reason the follow-up's description quotes. */
const FOLLOW_UP_REASON_MAX = 200;

/**
 * One approved call in the follow-up's description, its summary and reason quoted as JSON strings,
 * so agent-written text can't close the quote and read as instructions.
 */
const followUpLine = (s: SkippedActionDto): string =>
  `- ${JSON.stringify(s.summary)}: skipped because ${JSON.stringify(s.reason.slice(0, FOLLOW_UP_REASON_MAX))}`;

/** The follow-up's own criterion, before the source's. */
const FOLLOW_UP_CRITERION =
  'Each approved call has run, and what it held up in the earlier run is done.';

/** The longest source title the follow-up's own title quotes whole. */
const SOURCE_TITLE_MAX = 160;

/**
 * Run these now, in the answer's own write: the follow-up task, its approvals (exactly the skips the
 * item listed) and its follow-up row. Answers whether it made one, so the caller starts it once the
 * write commits. A source whose run is being retried, or that already has a follow-up, is refused.
 */
export function applySkippedChoice(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
  routine?: MadeRoutine,
): boolean {
  if (
    item.kind !== InboxKind.Flag ||
    (answer.choice !== SkippedChoice.RunTheseNow &&
      answer.choice !== SkippedChoice.RunAndMakeRoutine)
  )
    return false;
  // The detail is the item's own JSON, written when it was raised.
  const detail = SkippedDetail.safeParse(item.detail);
  if (!detail.success) return false;
  insertFollowUp(
    ctx,
    detail.data[SKIPPED_DETAIL],
    detail.data.skipIds,
    answer.choice === SkippedChoice.RunAndMakeRoutine
      ? { sourceInboxId: item.id, ...(routine === undefined ? {} : { told: routine }) }
      : null,
  );
  return true;
}

/**
 * Run These Now from the task's drawer, in the caller's write: the follow-up for every call the run
 * skipped that a follow-up can run approved, refused as the card's answer is. With `routine` it is Run and
 * Make Routine, which also approves each call's kind and tells `routine` each one.
 */
export function runSkippedCalls(
  ctx: WriteContext,
  source: WorkstreamId,
  routine?: MadeRoutine,
): TaskDto {
  const ids = approvableOf(listSkipsForWorkstream(ctx.tx, source)).map((s) => s.id);
  return insertFollowUp(
    ctx,
    source,
    ids,
    routine === undefined ? null : { sourceInboxId: null, told: routine },
  );
}

/**
 * Approves the kind of each skip, in the follow-up's write: an `active` row per program key, with the skips'
 * summaries as its examples, which also brings back a declined or revoked kind. The kind is `copy` scoped only when
 * every skip of the key ran in a copy. The hash of what it runs is read after the write commits.
 */
function makeKindsRoutine(
  ctx: WriteContext,
  projectId: ProjectId,
  skips: readonly SkippedActionDto[],
  sourceInboxId: InboxItemId | null,
  told: MadeRoutine | undefined,
): void {
  const byKey = new Map<string, SkippedActionDto[]>();
  for (const skip of skips) {
    if (skip.programKey === null) continue;
    byKey.set(skip.programKey, [...(byKey.get(skip.programKey) ?? []), skip]);
  }
  for (const [programKey, of] of byKey) {
    const inCopy = of.every((s) => {
      const batchId = getWorkstreamRow(ctx.tx, s.workstreamId).batchId;
      return batchId !== null && isLocalCopy(ctx.tx, batchId);
    });
    const scope = inCopy ? PrecedentScope.Copy : PrecedentScope.Project;
    approvePrecedent(ctx, {
      projectId,
      programKey,
      scope,
      kind: defaultPrecedentKind(programKey),
      examples: of.map((s) => s.summary),
      runsHash: null,
      state: PrecedentState.Active,
      sourceInboxId,
    });
    told?.({ programKey, scope });
  }
}

/** The follow-up task, its approvals (exactly `ids`) and its follow-up row. */
function insertFollowUp(
  ctx: WriteContext,
  source: WorkstreamId,
  ids: readonly SkippedActionId[],
  makeRoutine: { readonly sourceInboxId: InboxItemId | null; readonly told?: MadeRoutine } | null,
): TaskDto {
  if (ids.length === 0) throw new ConflictError('Nothing this item lists can be run approved');
  const row = getWorkstreamRow(ctx.tx, source);
  const sourceTask = getTask(ctx.tx, row.taskId);
  if (row.state !== WorkstreamState.Done && row.state !== WorkstreamState.Failed)
    throw new ConflictError(
      `"${sourceTask.title}" is being retried; Run these now waits until its run ends.`,
    );
  const existing = skipFollowUpOf(ctx.tx, source);
  if (existing !== null)
    throw new ConflictError(`"${sourceTask.title}" already has the follow-up "${existing.title}".`);
  const listed = new Set<string>(ids);
  // Only what the builder saw whole and may approve; a cut summary is never approvable.
  const approved = listSkipsForWorkstream(ctx.tx, source).filter(
    (s) => listed.has(s.id) && s.approval !== Approval.None,
  );
  if (approved.length === 0) throw new ConflictError('Nothing this item lists can be run approved');
  if (makeRoutine !== null && !makesRoutine(approved))
    throw new ConflictError(
      'Run and Make Routine needs every call to be one 10db’s judge doubted, with no limit named.',
    );
  const quoted =
    sourceTask.title.length > SOURCE_TITLE_MAX
      ? `${sourceTask.title.slice(0, SOURCE_TITLE_MAX)}…`
      : sourceTask.title;
  const task = insertTask(ctx, row.projectId, {
    title: `Run what "${quoted}" skipped`,
    description: [
      `The builder approved these calls, which an earlier run of "${sourceTask.title}" skipped. Run them, then finish what that run left undone because of them.`,
      ...approved.map(followUpLine),
      // The source's scope comes along, so the follow-up is checked against what the source promised.
      // Quoted as one JSON string, as the calls are, so none of it reads as an approved call.
      ...(sourceTask.description.trim() === ''
        ? []
        : ['', `What "${quoted}" set out to do: ${JSON.stringify(sourceTask.description)}`]),
    ].join('\n'),
    acceptanceCriteria: [
      FOLLOW_UP_CRITERION,
      // A follow-up of a follow-up already holds this line.
      ...sourceTask.acceptanceCriteria.filter((c) => c !== FOLLOW_UP_CRITERION),
    ],
    areas: sourceTask.areas,
  });
  approveSkips(
    ctx,
    task.id,
    approved.map((s) => s.id),
  );
  insertSkipFollowUp(ctx, {
    taskId: task.id,
    sourceWorkstreamId: source,
    sourceBatchId: row.batchId,
  });
  if (makeRoutine !== null)
    makeKindsRoutine(ctx, row.projectId, approved, makeRoutine.sourceInboxId, makeRoutine.told);
  return task;
}
