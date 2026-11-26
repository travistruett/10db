import { EventType, WorkstreamId, WorkstreamState } from '@10db/contracts';
import {
  activeClaims,
  claimsHeldBy,
  getProject,
  getTaskStartDirt,
  getWorkstreamRow,
  latestWorkstreamOf,
  listWorkstreams,
  releaseClaims,
  setTaskKeptWork,
  type DbReader,
  type WorkstreamRow,
  type WriteContext,
} from '@10db/db';
import {
  jobKey,
  JobQueue,
  laneBranchOf,
  runCommits,
  type DeliveryContext,
  type KeptWorkGate,
  type LaneBranch,
} from '../delivery';
import type { EventBus } from '../events';
import { CardTier, noteOnFailedCard, postNotice } from '../inbox';
import { findClaimed } from '../watcher';
import { withoutStartDirt } from './start-dirt';

type TakeOutContext = Pick<DeliveryContext, 'state' | 'folderHold' | 'git' | 'jobs' | 'logger'>;

/** What taking a failed run's work out of Your folder came to. */
type TakeOutOutcome =
  /** The work is on the lane branch and its files are back to the base's version. */
  | {
      readonly kind: 'kept';
      readonly keptSha: string;
      readonly keptBaseSha: string;
      readonly left: readonly string[];
    }
  /** The run committed nothing and left nothing in the folder. */
  | { readonly kind: 'nothing' }
  /** The base already holds the run's work: its landing was made before the run failed. */
  | { readonly kind: 'landed' }
  /** Your folder is on another branch, so nothing was moved. */
  | { readonly kind: 'off_base'; readonly found: string | null }
  /** Git refused or failed part-way; the files stay where they are. */
  | { readonly kind: 'failed'; readonly why: string };

/** The task notice a take-out leaves when no failed card speaks for the run. */
const takeOutKey = (row: WorkstreamRow): string => `lane-take-out:${row.taskId}`;

/**
 * When a Your-folder run of a Commit Directly project fails, its work comes out of the folder, so a
 * later lane's gate never meets it: what it left uncommitted is committed on its lane branch, each
 * of its files goes back to the base's version, and the lane's tip becomes the task's kept work,
 * which a Retry or a new start puts back before its lane launches. The base never had any of it.
 *
 * The failed run keeps its claims until its take-out has its work out, so no lane starts on its
 * files meanwhile; a take-out that could not move them keeps the claims until the run is retried
 * or cancelled. A failed run still holding claims when this starts listening has a take-out to
 * finish (a restart cut it short, or recovery failed the run before this listened), and gets one.
 */
export function subscribeLaneTakeOut(
  bus: EventBus,
  ctx: TakeOutContext,
  gate: Pick<KeptWorkGate, 'takingOut'>,
): () => void {
  const db = ctx.state.db;
  const queue = (failed: WorkstreamRow): void => {
    // From the failure until the work is out, a Retry of the run waits: it never launches on files
    // this job is still moving, and its start then puts the work back.
    const done = gate.takingOut(failed.id);
    ctx.jobs.run(
      jobKey({ projectId: failed.projectId, worktreePath: null }, JobQueue.Cut),
      async (signal) => {
        try {
          await takeOutWhenFree(ctx, failed, signal);
        } finally {
          done();
        }
      },
    );
  };
  for (const run of listWorkstreams(db, { states: [WorkstreamState.Failed] })) {
    const row = getWorkstreamRow(db, run.id);
    if (laneBranchOf(row) !== null && activeClaims(db, row.id).length > 0 && isLatest(db, row))
      queue(row);
  }
  return bus.subscribe((event) => {
    if (event.type !== EventType.WorkstreamChanged) return;
    if (event.data['to'] !== WorkstreamState.Failed) return;
    const id = WorkstreamId.safeParse(event.entityId);
    if (!id.success) return;
    const failed = getWorkstreamRow(db, id.data);
    if (laneBranchOf(failed) !== null) queue(failed);
  });
}

/** Takes the failed run's work out once Your folder is free, if the run is still failed by then. */
async function takeOutWhenFree(
  ctx: TakeOutContext,
  failed: WorkstreamRow,
  signal: AbortSignal,
): Promise<void> {
  const db = ctx.state.db;
  let token: symbol;
  try {
    token = await ctx.folderHold.reserveGitWhenFree(
      failed.projectId,
      'taking a failed run’s work out of Your folder',
      { signal },
    );
  } catch {
    // Cancelled by a shutdown: the run keeps its claims, and the next start finishes this.
    return;
  }
  try {
    // The job waited its turn. A run the builder started again meanwhile keeps its files: they are
    // still in the folder for its session, and nothing was recorded as saved to put back.
    // A run a new start of its task replaced has let go of its claims, and its files are the new
    // run's to meet: nothing comes out under it.
    const row = getWorkstreamRow(db, failed.id);
    const lane = laneBranchOf(row);
    if (row.state !== WorkstreamState.Failed || lane === null || !isLatest(db, row)) return;
    const outcome = await takeOut(ctx, row, lane).catch((error: unknown): TakeOutOutcome => {
      const why = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(
        { workstreamId: row.id, err: why },
        'a failed run’s work was not taken out of Your folder',
      );
      return { kind: 'failed', why };
    });
    settle(ctx, row, lane, outcome);
  } finally {
    ctx.folderHold.releaseGit(token);
  }
}

/** Whether `row` is its task's newest run, the one a take-out or a Retry acts on. */
const isLatest = (db: DbReader, row: WorkstreamRow): boolean =>
  latestWorkstreamOf(db, row.taskId)?.id === row.id;

/**
 * A new start of the task replaces its failed lane run, which a Retry would have continued: the
 * failed run lets go of the claims it kept because its work could not be taken out of Your folder
 * (or before its take-out's turn), so the new run and the tasks sharing its areas can start. A task
 * notice says where the replaced run's work may still be.
 */
export function releaseReplacedLaneRun(w: WriteContext, id: WorkstreamId): void {
  const row = getWorkstreamRow(w.tx, id);
  const lane = laneBranchOf(row);
  if (row.state !== WorkstreamState.Failed || lane === null) return;
  if (releaseClaims(w, id) === 0) return;
  postNotice(w, {
    projectId: row.projectId,
    tier: CardTier.Notice,
    taskId: row.taskId,
    key: takeOutKey(row),
    tone: 'warning',
    line: 'The replaced run’s files may still be in Your folder',
    body: `A new run of this task starts in place of a failed one whose work was not taken out of Your folder. What the failed run committed is on branch ${lane.lane}; any of its files still in Your folder stay there, and the new run starts with them.`,
  });
}

/** Every claim another workstream of the project holds now. */
function othersClaims(db: DbReader, row: WorkstreamRow) {
  return listWorkstreams(db, { projectId: row.projectId })
    .filter((w) => w.id !== row.id)
    .flatMap((w) => activeClaims(db, w.id))
    .map((c) => ({ kind: c.kind, name: c.name }));
}

async function takeOut(
  ctx: TakeOutContext,
  row: WorkstreamRow,
  lane: LaneBranch,
): Promise<TakeOutOutcome> {
  const db = ctx.state.db;
  const { git } = ctx;
  const project = getProject(db, row.projectId);
  const checkout = project.repoPath;
  // Files go back to the base's version only while the folder is on the base.
  const head = await git.currentBranch(checkout);
  if (head !== lane.base) return { kind: 'off_base', found: head };
  const baseTip = await git.branchTip(checkout, lane.base);
  if (baseTip === null) return { kind: 'failed', why: `branch ${lane.base} is gone` };
  const changed = await git.changedPaths(checkout);
  const before = await runCommits({ db, git }, row, checkout, lane.base, lane.base);
  const committed = new Set(
    (
      await Promise.all(before.ranges.map((r) => git.filesChangedBetween(checkout, r.base, r.head)))
    ).flat(),
  );
  // What the run held its claims over and left changed, less what was there before it ran or what
  // it named as another writer's, and the files its lane commits changed; never a path another run
  // holds a claim on now, which is that run's work.
  const claims = claimsHeldBy(db, row.id).map((c) => ({ kind: c.kind, name: c.name }));
  const claimed = withoutStartDirt(
    findClaimed(changed, project, claims),
    checkout,
    getTaskStartDirt(db, row.taskId),
  );
  const theirs = new Set(findClaimed(changed, project, othersClaims(db, row)));
  const paths = [...new Set([...claimed, ...changed.filter((p) => committed.has(p))])]
    .filter((p) => !theirs.has(p))
    .sort();
  if (paths.length === 0 && before.ranges.length === 0) return { kind: 'nothing' };
  // Everything the folder holds of the run goes on the lane branch first, so nothing is lost below.
  const laneTip = await git.branchTip(checkout, lane.lane);
  const onDisk = await git.hashOnDisk(checkout, paths);
  const unsaved: string[] = [];
  for (const entry of onDisk) {
    const kept = laneTip === null ? null : await git.blobAt(checkout, laneTip, entry.path);
    if (laneTip === null || entry.blob !== kept) unsaved.push(entry.path);
  }
  if (unsaved.length > 0)
    await git.commitOnBranch({
      repo: checkout,
      branch: lane.lane,
      checkedOut: lane.base,
      startAt: baseTip,
      paths: unsaved,
      message: '10db: unfinished work kept',
      opId: `kept-${row.id}-${row.updatedAt}`,
    });
  const keptSha = await git.branchTip(checkout, lane.lane);
  if (keptSha === null) return { kind: 'nothing' };
  // A landing made before the run failed (a restart between it and the run's last write, then a
  // gate that failed on the run again) left the base holding the run's work: nothing comes out.
  if (unsaved.length === 0 && committed.size > 0) {
    let onBase = true;
    for (const path of committed)
      if (
        (await git.blobAt(checkout, baseTip, path)) !== (await git.blobAt(checkout, keptSha, path))
      )
        onBase = false;
    if (onBase) return { kind: 'landed' };
  }
  // The base commit the lane started on: a put-back then merges only the run's own changes into a
  // base other runs moved since.
  const keptBaseSha = (await git.mergeBase(checkout, keptSha, baseTip)) ?? baseTip;
  const restored = await git.restoreFiles(
    checkout,
    paths.map((path) => ({ path, from: baseTip })),
    onDisk.map((entry) => ({ path: entry.path, blob: entry.blob })),
  );
  return { kind: 'kept', keptSha, keptBaseSha, left: restored.left };
}

/** What the failed card says of the run's work once its take-out ended. */
function noteFor(lane: LaneBranch, outcome: TakeOutOutcome): string {
  const waits =
    'Tasks that share its areas wait until the run is retried from this card or its task is started again.';
  switch (outcome.kind) {
    case 'kept': {
      const left =
        outcome.left.length === 0
          ? ''
          : ` These changed again meanwhile and were left in Your folder: ${outcome.left.join(', ')}.`;
      return `Nothing of this run reached ${lane.base}. Its work is on branch ${lane.lane}, and its files in Your folder are back to ${lane.base}; Retry puts the work back.${left}`;
    }
    case 'nothing':
      return `Nothing of this run reached ${lane.base}, and it left no work to keep.`;
    case 'landed':
      return `This run’s work had already landed on ${lane.base} before it failed: ${lane.base} holds what branch ${lane.lane} does, so nothing was taken out of Your folder.`;
    case 'off_base':
      return `Your folder is on ${outcome.found ?? 'no branch'}, not ${lane.base}, so the run’s files were left where they are; what it committed is on branch ${lane.lane}. ${waits}`;
    case 'failed':
      return `The run’s work could not be taken out of Your folder (${outcome.why}), so its files are still there; what it committed is on branch ${lane.lane}. ${waits}`;
  }
}

/** The one line of the notice a take-out leaves when no failed card speaks for the run. */
function lineFor(lane: LaneBranch, outcome: TakeOutOutcome): string {
  switch (outcome.kind) {
    case 'kept':
      return `The failed run’s work is kept on branch ${lane.lane}`;
    case 'nothing':
      return 'The failed run left no work to keep';
    case 'landed':
      return `The failed run’s work is already on ${lane.base}`;
    case 'off_base':
    case 'failed':
      return 'The failed run’s files are still in Your folder';
  }
}

/**
 * Records what the take-out came to, in one write: the kept work a Retry puts back, the failed
 * card's account of the work, and, once the work is out of the folder, the run's claims.
 */
function settle(
  ctx: TakeOutContext,
  failed: WorkstreamRow,
  lane: LaneBranch,
  outcome: TakeOutOutcome,
): void {
  ctx.state.write((w) => {
    // Recorded even when the run was retried meanwhile: its files are out, and its start puts them back.
    if (outcome.kind === 'kept')
      setTaskKeptWork(w, failed.taskId, {
        keptSha: outcome.keptSha,
        keptBaseSha: outcome.keptBaseSha,
      });
    const row = getWorkstreamRow(w.tx, failed.id);
    if (row.state !== WorkstreamState.Failed) return;
    const out = outcome.kind !== 'off_base' && outcome.kind !== 'failed';
    if (out) releaseClaims(w, row.id);
    const note = noteFor(lane, outcome);
    if (!noteOnFailedCard(w, row, note))
      postNotice(w, {
        projectId: row.projectId,
        tier: CardTier.Notice,
        taskId: row.taskId,
        key: takeOutKey(row),
        tone: out ? 'info' : 'warning',
        line: lineFor(lane, outcome),
        body: note,
      });
  });
}
