import {
  Approval,
  ConflictError,
  InboxKind,
  SkipKind,
  SkippedActionId,
  WorkstreamId,
  WorkstreamState,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type SkippedActionDto,
  Urgency,
} from '@10db/contracts';
import {
  approveSkips,
  getTask,
  getWorkstreamRow,
  insertSkipFollowUp,
  insertTask,
  skipFollowUpOf,
  lastConfigHead,
  lastListed,
  passHoldingTask,
  listSkipsForWorkstream,
  markListed,
  unlistedEndedRuns,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { flagCard, BY_ANSWER, CardTier } from '../inbox';
import type { Logger } from '../log';
import { LIMITS, writtenConfig } from '../trust';
import { checkoutOf } from './checkout';
import { followUpStart } from './follow-up-start';
import { sourceStateOf } from './skip-follow-up';

// Trust line §5: when an unattended run ends, one Inbox item lists what it skipped, the questions it
// was answered at once and the config it wrote, each once. It is marked in
// `skip_listings` in its own write, so a crash or a retry neither loses it nor repeats it.

/** The item's detail key: the run it lists. Its `skipIds` are the approvable skips it showed. */
export const SKIPPED_DETAIL = 'skippedRun';

/** The answers the item offers; the card shows them as written. */
export const SkippedChoice = {
  RunTheseNow: 'Run these now',
  Dismiss: 'Dismiss',
} as const;
export type SkippedChoice = (typeof SkippedChoice)[keyof typeof SkippedChoice];

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
    const skipIds = skips
      .filter((s) => s.kind !== SkipKind.Question && s.approval !== Approval.None)
      .map((s) => s.id);
    const item = flagCard(ctx, {
      projectId: row.projectId,
      workstreamId: null,
      tier: CardTier.Ask,
      urgency: Urgency.Normal,
      closesWhen: BY_ANSWER,
      title: `Skipped while you were away: ${task.title}`,
      body: bodyOf(skips, written),
      options:
        skipIds.length === 0
          ? [DISMISS]
          : [
              runOption(followUpStart(sourceStateOf(ctx.tx, workstreamId)).kind === 'wait'),
              DISMISS,
            ],
      recommendation: null,
      detail: { [SKIPPED_DETAIL]: workstreamId, skipIds },
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
): boolean {
  if (item.kind !== InboxKind.Flag || answer.choice !== SkippedChoice.RunTheseNow) return false;
  // The detail is the item's own JSON, written when it was raised.
  const detail = SkippedDetail.safeParse(item.detail);
  if (!detail.success) return false;
  const source = detail.data[SKIPPED_DETAIL];
  const ids = detail.data.skipIds;
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
  const quoted =
    sourceTask.title.length > SOURCE_TITLE_MAX
      ? `${sourceTask.title.slice(0, SOURCE_TITLE_MAX)}…`
      : sourceTask.title;
  const task = insertTask(ctx, row.projectId, {
    title: `Run what "${quoted}" skipped`,
    description: [
      `The builder approved these calls, which an earlier run of "${sourceTask.title}" skipped. Run them, then finish what that run left undone because of them.`,
      ...approved.map(followUpLine),
    ].join('\n'),
    acceptanceCriteria: [
      'Each approved call has run, and what it held up in the earlier run is done.',
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
  return true;
}
