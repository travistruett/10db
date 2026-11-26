import { EventType, WorkstreamId, WorkstreamState } from '@10db/contracts';
import {
  claimsHeldBy,
  getProject,
  getTaskStartDirt,
  getWorkstreamRow,
  setTaskKeptWork,
  type WorkstreamRow,
} from '@10db/db';
import {
  jobKey,
  JobQueue,
  laneBranchOf,
  runCommits,
  type DeliveryContext,
  type LaneBranch,
} from '../delivery';
import type { EventBus } from '../events';
import { CardTier, postNotice, type NoticeInput } from '../inbox';
import { findClaimed } from '../watcher';
import { withoutStartDirt } from './start-dirt';

type TakeOutContext = Pick<DeliveryContext, 'state' | 'folderHold' | 'git' | 'jobs' | 'logger'>;

/** The task notice a take-out leaves, one per task, the latest saying where its work is. */
const takeOutKey = (row: WorkstreamRow): string => `lane-take-out:${row.taskId}`;

/**
 * When a Your-folder run of a Commit Directly project fails, its work comes out of the folder, so a
 * later lane's gate never meets it: what it left uncommitted is committed on its lane branch, each
 * of its files goes back to the base's version, and the lane's tip becomes the task's kept work,
 * which a Retry or a new start puts back before its lane launches. The base never had any of it.
 */
export function subscribeLaneTakeOut(bus: EventBus, ctx: TakeOutContext): () => void {
  const db = ctx.state.db;
  return bus.subscribe((event) => {
    if (event.type !== EventType.WorkstreamChanged) return;
    if (event.data['to'] !== WorkstreamState.Failed) return;
    const id = WorkstreamId.safeParse(event.entityId);
    if (!id.success) return;
    const row = getWorkstreamRow(db, id.data);
    const lane = laneBranchOf(db, row);
    if (lane === null) return;
    ctx.jobs.run(
      jobKey({ projectId: row.projectId, worktreePath: null }, JobQueue.Cut),
      async (signal) => {
        let token: symbol;
        try {
          token = await ctx.folderHold.reserveGitWhenFree(
            row.projectId,
            'taking a failed run’s work out of Your folder',
            { signal },
          );
        } catch {
          return;
        }
        try {
          await takeOut(ctx, row, lane);
        } catch (error) {
          ctx.logger.warn(
            { workstreamId: row.id, err: error instanceof Error ? error.message : String(error) },
            'a failed run’s work was not taken out of Your folder',
          );
        } finally {
          ctx.folderHold.releaseGit(token);
        }
      },
    );
  });
}

async function takeOut(ctx: TakeOutContext, row: WorkstreamRow, lane: LaneBranch): Promise<void> {
  const db = ctx.state.db;
  const { git } = ctx;
  const project = getProject(db, row.projectId);
  const checkout = project.repoPath;
  // Files go back to the base's version only while the folder is on the base.
  if ((await git.currentBranch(checkout)) !== lane.base) {
    ctx.state.write((w) => {
      postNotice(
        w,
        notice(
          row,
          lane,
          `Your folder is not on ${lane.base}, so the run’s files were left where they are.`,
        ),
      );
    });
    return;
  }
  const baseTip = await git.branchTip(checkout, lane.base);
  if (baseTip === null) return;
  const changed = await git.changedPaths(checkout);
  const before = await runCommits({ db, git }, row, checkout, lane.base, lane.base);
  const committed = new Set(
    before.ranges.length === 0
      ? []
      : (
          await Promise.all(
            before.ranges.map((r) => git.filesChangedBetween(checkout, r.base, r.head)),
          )
        ).flat(),
  );
  // What the run held its claims over and left changed, less what was there before it ran or what
  // it named as another writer's, and the files its lane commits changed.
  const claims = claimsHeldBy(db, row.id).map((c) => ({ kind: c.kind, name: c.name }));
  const claimed = withoutStartDirt(
    findClaimed(changed, project, claims),
    checkout,
    getTaskStartDirt(db, row.taskId),
  );
  const paths = [...new Set([...claimed, ...changed.filter((p) => committed.has(p))])].sort();
  if (paths.length === 0 && before.ranges.length === 0) return;
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
  if (keptSha === null) return;
  // The base commit the lane started on: a put-back then merges only the run's own changes into a
  // base other runs moved since.
  const keptBaseSha = (await git.mergeBase(checkout, keptSha, baseTip)) ?? baseTip;
  const restored = await git.restoreFiles(
    checkout,
    paths.map((path) => ({ path, from: baseTip })),
    onDisk.map((entry) => ({ path: entry.path, blob: entry.blob })),
  );
  ctx.state.write((w) => {
    setTaskKeptWork(w, row.taskId, { keptSha, keptBaseSha });
    const left =
      restored.left.length === 0
        ? ''
        : ` These changed again meanwhile and were left in Your folder: ${restored.left.join(', ')}.`;
    postNotice(
      w,
      notice(
        row,
        lane,
        `Nothing reached ${lane.base}. The run’s work is on branch ${lane.lane}, and its files in Your folder are back to ${lane.base}; Retry puts the work back.${left}`,
      ),
    );
  });
}

function notice(row: WorkstreamRow, lane: LaneBranch, body: string): NoticeInput {
  return {
    projectId: row.projectId,
    tier: CardTier.Notice,
    taskId: row.taskId,
    key: takeOutKey(row),
    tone: 'info',
    line: `The failed run’s work is kept on branch ${lane.lane}`,
    body,
  };
}
