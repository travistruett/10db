import {
  Approval,
  SkipKind,
  WorkstreamState,
  type InboxOption,
  type SkippedActionDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getTask,
  getWorkstreamRow,
  lastListed,
  passHoldingTask,
  listSkipsForWorkstream,
  markListed,
  unlistedEndedRuns,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { flagCard } from '../inbox';
import type { Logger } from '../log';
import { LIMITS, writtenConfig } from '../trust';
import { checkoutOf } from './checkout';

// Trust line §5 and T4 call 12: when an unattended run ends, one Inbox item lists what it skipped,
// the questions it was answered at once and the config it wrote, each once. It is marked in
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
  readonly git: Pick<Git, 'changedFilesSince'>;
  readonly log: Logger;
}

/** What clears a skip no follow-up can run, in the builder's words. */
function clearedBy(kind: SkipKind): string {
  switch (kind) {
    case SkipKind.DockerOff:
      return 'turn Docker on in Settings › Project';
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

/** The run's changed paths, as the review step reads them; null when they can't be read. */
async function changedPaths(
  deps: SkippedCardDeps,
  workstreamId: WorkstreamId,
): Promise<string[] | null> {
  const db = deps.state.db;
  const row = getWorkstreamRow(db, workstreamId);
  if (row.baseHead === null) return null;
  try {
    return await deps.git.changedFilesSince(checkoutOf(db, row), row.baseHead);
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
  // Config is listed on the run's first item only.
  const config = pass || last !== undefined ? [] : await changedPaths(deps, workstreamId);
  const written = config === null ? null : writtenConfig(config);
  const through = skips.at(-1)?.id ?? last ?? null;
  deps.state.write((ctx: WriteContext) => {
    // Another check of the run got here first while the paths were read.
    if (lastListed(ctx.tx, workstreamId) !== last) return;
    if (skips.length === 0 && (written === null || written.length === 0)) {
      markListed(ctx, workstreamId, through, null);
      return;
    }
    const task = getTask(ctx.tx, row.taskId);
    const skipIds = skips
      .filter((s) => s.kind !== SkipKind.Question && s.approval !== Approval.None)
      .map((s) => s.id);
    const item = flagCard(ctx, {
      projectId: row.projectId,
      workstreamId: null,
      title: `Skipped while you were away: ${task.title}`,
      body: bodyOf(skips, written),
      options: [DISMISS],
      recommendation: null,
      detail: { [SKIPPED_DETAIL]: workstreamId, skipIds },
      foldKey: `skipped:${workstreamId}:${through ?? 'none'}`,
    });
    markListed(ctx, workstreamId, through, item.id);
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
