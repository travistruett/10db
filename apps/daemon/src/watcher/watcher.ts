import { existsSync, watch as fsWatch } from 'node:fs';
import { join, sep } from 'node:path';
import {
  ACTIVE_STATES,
  ClaimKind,
  EventType,
  InboxKind,
  InboxState,
  LANE_STATES,
  WorkstreamId,
  WorkstreamState,
  type BatchId,
  type InboxItemDto,
  type ProjectDto,
  type ProjectId,
} from '@10db/contracts';
import {
  activeClaims,
  copyHazardNames,
  getBatch,
  getProject,
  getWorkstream,
  listInbox,
  listWorkstreams,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import { checkoutOf } from '../delivery';
import type { EventBus, StateStore } from '../events';
import { existsAsEntry, GitTrustError, type Git } from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import {
  bookkeepingAt,
  ignoredBookkeepingWrite,
  isInsideClaudeCodeBookkeeping,
} from './claude-code-bookkeeping';
import {
  bulkFoldKey,
  findForeignClaimWrites,
  findStrays,
  foreignBulkFoldKey,
  isAlwaysIgnored,
  isSensitivePath,
  splitSensitive,
  type ClaimHolder,
  STRAY_BULK_THRESHOLD,
  strayFoldKey,
} from './strays';

const WATCH_BATCH_MS = 500;
const BULK_LISTED = 20;
const WATCHED_STATES = [...LANE_STATES, WorkstreamState.WaitingHuman];
/**
 * Whose claims excuse a write at a step's end: every unfinished workstream but one a human took over. A lane
 * that edited inside its own claim and then stopped to wait made that write itself; a write into an idle
 * lane's claim by someone else is the real-time batch's to report, as a foreign write.
 */
const STEP_END_CLAIM_STATES = ACTIVE_STATES.filter((s) => s !== WorkstreamState.TakenOver);

/**
 * Whether a claim is exclusive per copy of the repository (every area, and a per-copy hazard), so it
 * excuses or blocks writes only in its holder's checkout, rather than in every checkout of the project.
 */
function perCopyClaims(
  project: Pick<ProjectDto, 'hazards'>,
): (claim: { readonly kind: ClaimKind; readonly name: string }) => boolean {
  const copyHazards = copyHazardNames(project);
  return (claim) => claim.kind === ClaimKind.Area || copyHazards.has(claim.name);
}

export type WatchFn = (
  root: string,
  onChange: (rel: string) => void,
  onError: (error: Error) => void,
) => { close(): void };

/** Recursive fs.watch: FSEvents on macOS, inotify on Linux. Paths come back repo-relative with `/`. */
export const systemWatch: WatchFn = (root, onChange, onError) => {
  const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
    if (filename) onChange(filename.split(sep).join('/'));
  });
  watcher.on('error', onError);
  return {
    close: () => {
      watcher.close();
    },
  };
};

export interface Watcher {
  /** Watches every checkout (a project's, or a batch's worktree) with active work and stops watching the rest. */
  sync(): void;
  /** Diffs git status against the claims after a session; returns the strays it flagged. */
  stepEnd(workstreamId: WorkstreamId): Promise<string[]>;
  /** Processes pending changes now instead of at the next batch. */
  flush(): Promise<void>;
  stop(): void;
}

const STRAY_TITLE = 'Write outside every claim';

export function createWatcher(deps: {
  readonly state: StateStore;
  /** When given, a claim granted mid-run resolves the stray cards it now covers (`resolveCovered`). */
  readonly bus?: EventBus;
  readonly inbox: InboxService;
  readonly git: Git;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly watch?: WatchFn;
  readonly batchMs?: number;
}): Watcher {
  const db = deps.state.db;
  const watch = deps.watch ?? systemWatch;
  const batchMs = deps.batchMs ?? WATCH_BATCH_MS;
  // Keyed by the checkout's path. `batchId` is set for a batch's worktree, null for a project's own checkout.
  const watched = new Map<
    string,
    {
      readonly projectId: ProjectId;
      readonly batchId: BatchId | null;
      readonly root: string;
      readonly handle: { close(): void };
    }
  >();
  const pending = new Map<string, Set<string>>();
  let timer: Timer | null = null;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  /** The batch a workstream works in when that batch has its own worktree. */
  function worktreeBatchOf(ws: { readonly batchId: BatchId | null }): BatchId | null {
    if (ws.batchId === null) return null;
    return getBatch(db, ws.batchId).worktreePath === null ? null : ws.batchId;
  }

  function unwatch(root: string): void {
    watched.get(root)?.handle.close();
    watched.delete(root);
    pending.delete(root);
  }

  function enqueue(root: string, rel: string): void {
    if (stopped || rel === '' || isAlwaysIgnored(rel)) return;
    const set = pending.get(root) ?? new Set<string>();
    set.add(rel);
    pending.set(root, set);
    timer ??= deps.clock.setTimeout(() => {
      timer = null;
      void flush();
    }, batchMs);
  }

  /** Where a write happened: fold keys scope to the batch in a worktree, and its cards name the path. */
  interface Site {
    readonly scope: string;
    readonly worktree: string | null;
  }

  const siteOf = (project: ProjectDto, batchId: BatchId | null, root: string): Site =>
    batchId === null ? { scope: project.id, worktree: null } : { scope: batchId, worktree: root };

  const labelled = (site: Site, rel: string): string =>
    site.worktree === null ? rel : `${site.worktree}: ${rel}`;

  function raise(
    project: ProjectDto,
    site: Site,
    strays: readonly string[],
    candidates: readonly WorkstreamId[],
    owner: WorkstreamId | null,
  ): void {
    if (strays.length === 0) return;
    const workstreamId = owner ?? (candidates.length === 1 ? (candidates[0] ?? null) : null);
    // A write that can change what runs gets its own card, so a bulk card never buries it.
    const { sensitive, ordinary } = splitSensitive(strays, (rel) => rel);
    const single = (rel: string): void => {
      deps.inbox.flag({
        projectId: project.id,
        workstreamId,
        title: STRAY_TITLE,
        body: labelled(site, rel),
        detail: { path: rel, candidates: [...candidates] },
        foldKey: strayFoldKey(site.scope, rel),
      });
    };
    sensitive.forEach(single);
    if (ordinary.length > STRAY_BULK_THRESHOLD) {
      const listed = ordinary.slice(0, BULK_LISTED);
      deps.inbox.flag({
        projectId: project.id,
        workstreamId,
        title: `${String(ordinary.length)} writes outside every claim`,
        body: `${listed.map((rel) => labelled(site, rel)).join('\n')}\n…and ${String(ordinary.length - listed.length)} more`,
        detail: { count: ordinary.length, paths: listed, candidates: [...candidates] },
        foldKey: bulkFoldKey(site.scope),
      });
      return;
    }
    ordinary.forEach(single);
  }

  /**
   * Strays among `paths` against the claims of the workstreams in `claimStates`, plus any in `alsoHeldBy`.
   * Area claims and per-copy hazard claims count from the batch's workstreams in a worktree and from the project's
   * workstreams outside any worktree in the main checkout; the other hazard claims always count from the project's,
   * since that hazard names something the worktrees share.
   */
  function straysIn(
    project: ProjectDto,
    batchId: BatchId | null,
    paths: readonly string[],
    claimStates: readonly WorkstreamState[],
    alsoHeldBy: WorkstreamId | null,
  ): { strays: string[]; candidates: WorkstreamId[] } {
    const isPerCopy = perCopyClaims(project);
    const inScope = (ws: { readonly batchId: BatchId | null }) => worktreeBatchOf(ws) === batchId;
    const holders = listWorkstreams(db, { states: claimStates, projectId: project.id });
    const ids = holders.map((ws) => ws.id);
    const areaHolders = new Set(holders.filter(inScope).map((ws) => ws.id));
    if (alsoHeldBy) {
      areaHolders.add(alsoHeldBy);
      if (!ids.includes(alsoHeldBy)) ids.push(alsoHeldBy);
    }
    const claims = ids.flatMap((id) =>
      activeClaims(db, id)
        .filter((c) => !isPerCopy(c) || areaHolders.has(id))
        .map((c) => ({ kind: c.kind, name: c.name })),
    );
    const candidates = listWorkstreams(db, { states: WATCHED_STATES, projectId: project.id })
      .filter(inScope)
      .map((ws) => ws.id);
    return { strays: findStrays(paths, project, claims), candidates };
  }

  /** Writes inside a claim whose holder isn't running, attributed to the sessions that are. */
  function raiseForeign(
    project: ProjectDto,
    site: Site,
    batchId: BatchId | null,
    paths: readonly string[],
  ): void {
    if (paths.length === 0) return;
    const isPerCopy = perCopyClaims(project);
    const holders: ClaimHolder[] = listWorkstreams(db, {
      states: ACTIVE_STATES,
      projectId: project.id,
    }).map((ws) => ({
      id: ws.id,
      // A lane in another checkout holds its claims but isn't writing here, so a write into them is foreign.
      running: LANE_STATES.includes(ws.state) && worktreeBatchOf(ws) === batchId,
      claims: activeClaims(db, ws.id)
        .filter((c) => !isPerCopy(c) || worktreeBatchOf(ws) === batchId)
        .map((c) => ({ kind: c.kind, name: c.name })),
    }));
    const foreign = findForeignClaimWrites(paths, project, holders);
    if (foreign.length === 0) return;
    const running = holders.filter((h) => h.running).map((h) => h.id);
    const workstreamId = running.length === 1 ? (running[0] ?? null) : null;
    const { sensitive, ordinary } = splitSensitive(foreign, (f) => f.path);
    const single = ({ path, holders: claimedBy }: (typeof foreign)[number]): void => {
      deps.inbox.flag({
        projectId: project.id,
        workstreamId,
        title: "Write inside another workstream's claim",
        body: labelled(site, path),
        detail: { path, candidates: running, claimedBy },
        foldKey: strayFoldKey(site.scope, path),
      });
    };
    sensitive.forEach(single);
    if (ordinary.length > STRAY_BULK_THRESHOLD) {
      const listed = ordinary.slice(0, BULK_LISTED).map((f) => f.path);
      deps.inbox.flag({
        projectId: project.id,
        workstreamId,
        title: `${String(ordinary.length)} writes inside another workstream's claim`,
        body: `${listed.map((rel) => labelled(site, rel)).join('\n')}\n…and ${String(ordinary.length - listed.length)} more`,
        detail: { count: ordinary.length, paths: listed, candidates: running },
        foldKey: foreignBulkFoldKey(site.scope),
      });
      return;
    }
    ordinary.forEach(single);
  }

  /** Whether a card names the lane: as the workstream it targets, or as one of its candidates. */
  function names(item: InboxItemDto, lane: WorkstreamId): boolean {
    const candidates = item.detail?.['candidates'];
    return (
      item.targets.some((t) => t.workstreamId === lane) ||
      (Array.isArray(candidates) && candidates.includes(lane))
    );
  }

  /**
   * Resolves each open stray card that names `lane`, in the lane's own checkout, whose path a claim the lane
   * now holds covers. A lane can run before it holds the claim its work needs (a task with no areas launches
   * holding nothing, and takes one through request_claim), so the writes the watcher saw before the grant
   * were carded; once that lane holds a claim over them they are its own work. A claim granted to any other
   * lane, in this checkout or another, resolves nothing: that lane didn't make the write, so the card stays.
   * Sensitive paths stay carded.
   */
  function resolveCovered(lane: WorkstreamId): void {
    if (stopped) return;
    const ws = getWorkstream(db, lane);
    const open = listInbox(db, { states: [InboxState.Open], projectId: ws.projectId }).filter(
      (item) => item.kind === InboxKind.Flag && item.title === STRAY_TITLE && names(item, lane),
    );
    if (open.length === 0) return;
    const project = getProject(db, ws.projectId);
    const site = siteOf(project, worktreeBatchOf(ws), checkoutOf(db, ws));
    // Every claim the lane holds counts in its own checkout, the one its per-copy claims are scoped to.
    const claims = activeClaims(db, lane).map((c) => ({ kind: c.kind, name: c.name }));
    for (const item of open) {
      const path = item.detail?.['path'];
      if (typeof path !== 'string' || isSensitivePath(path)) continue;
      if (item.body !== labelled(site, path)) continue;
      if (findStrays([path], project, claims).length > 0) continue;
      deps.inbox.resolve(item.id, 'The lane it names now holds a claim covering it.');
    }
  }

  /** Logs a path dropped because it is Claude Code's bookkeeping, so the log shows what the list hides. */
  function logBookkeeping(
    projectId: ProjectId,
    root: string,
    rel: string,
    entries: readonly { writtenBy: string }[],
  ): void {
    deps.logger.info(
      { projectId, root, path: rel, writtenBy: entries.map((e) => e.writtenBy).join(' ') },
      'ignored a Claude Code bookkeeping write',
    );
  }

  /** Drops the files Claude Code writes for its own bookkeeping, which raise no card, and logs each one. */
  function withoutBookkeeping(
    projectId: ProjectId,
    root: string,
    paths: readonly string[],
  ): string[] {
    return paths.filter((rel) => {
      const ignored = ignoredBookkeepingWrite(root, rel);
      if (ignored) logBookkeeping(projectId, root, rel, [ignored]);
      return !ignored;
    });
  }

  async function processBatch(root: string, allPaths: readonly string[]): Promise<void> {
    const entry = watched.get(root);
    if (!entry) return;
    const { projectId, batchId } = entry;
    if (!existsSync(entry.root)) {
      deps.logger.warn({ projectId }, 'the watched repository is gone; stopped watching it');
      unwatch(root);
      return;
    }
    const paths = withoutBookkeeping(projectId, entry.root, allPaths);
    if (paths.length === 0) return;
    // Only what git still sees as changed now. This drops ignored files and directories. It also drops files
    // already committed through 10db's claim-checked commit, whose claims may have been released since the write.
    // A checkout git refuses to run in (a lane may have written its config) has a card of its own; its
    // sensitive paths are still flagged below.
    const changed = new Set(
      await deps.git.changedPaths(entry.root, paths).catch((error: unknown) => {
        if (error instanceof GitTrustError) return [];
        throw error;
      }),
    );
    const project = getProject(db, projectId);
    const reported = paths.filter((rel) => changed.has(rel));
    const site = siteOf(project, batchId, entry.root);
    const { strays, candidates } = straysIn(project, batchId, reported, ACTIVE_STATES, null);
    // Paths that can change what runs are flagged whatever the claims say, whether git reports them or not: a
    // claim over the whole repository covers a `.mcp.json` in it too. Claude Code's staging directory, as a
    // real directory, is its bookkeeping, and a sensitive directory holding only that is the `.claude/` a
    // session start made for it. Each one dropped as bookkeeping is logged.
    const hidden: string[] = [];
    for (const rel of paths) {
      if (changed.has(rel) && !isSensitivePath(rel)) continue;
      if (!isSensitivePath(rel) && !isInsideClaudeCodeBookkeeping(rel)) continue;
      if (!existsAsEntry(join(entry.root, rel))) continue;
      const bookkeeping = bookkeepingAt(entry.root, rel);
      if (bookkeeping.length > 0) logBookkeeping(projectId, entry.root, rel, bookkeeping);
      else if (isSensitivePath(rel)) hidden.push(rel);
    }
    const flagged = [...new Set([...strays, ...hidden])];
    raise(project, site, flagged, candidates, null);
    const outside = new Set(flagged);
    raiseForeign(
      project,
      site,
      batchId,
      reported.filter((rel) => !outside.has(rel)),
    );
  }

  async function processPending(): Promise<void> {
    const batches = [...pending.entries()].map(([id, set]) => [id, [...set].sort()] as const);
    pending.clear();
    for (const [root, paths] of batches) {
      try {
        await processBatch(root, paths);
      } catch (error) {
        deps.logger.warn({ root, err: String(error) }, 'watcher batch failed');
      }
    }
  }

  function flush(): Promise<void> {
    timer?.cancel();
    timer = null;
    chain = chain.then(processPending);
    return chain;
  }

  // Queued behind any batch in progress, so a card that batch raises is checked too; outside the write
  // that published the grant, since resolving a card is a write of its own. Only the lane granted the claim
  // can clear cards, and only its own.
  const unsubscribe =
    deps.bus?.subscribe((event) => {
      if (event.type !== EventType.ClaimAcquired || stopped) return;
      const lane = WorkstreamId.safeParse(event.data['workstreamId']);
      if (!lane.success) return;
      chain = chain
        .then(() => {
          resolveCovered(lane.data);
        })
        .catch((error: unknown) => {
          deps.logger.warn({ err: String(error) }, 'could not re-check stray cards after a claim');
        });
    }) ?? (() => undefined);

  return {
    sync() {
      if (stopped) return;
      const wanted = new Map<string, { projectId: ProjectId; batchId: BatchId | null }>();
      for (const ws of listWorkstreams(db, { states: WATCHED_STATES })) {
        const root = checkoutOf(db, ws);
        if (!wanted.has(root))
          wanted.set(root, { projectId: ws.projectId, batchId: worktreeBatchOf(ws) });
      }
      for (const root of [...watched.keys()]) if (!wanted.has(root)) unwatch(root);
      for (const [root, { projectId, batchId }] of wanted) {
        if (watched.has(root) || !existsSync(root)) continue;
        try {
          const handle = watch(
            root,
            (rel) => {
              enqueue(root, rel);
            },
            (error) => {
              deps.logger.warn(
                { projectId, root, err: error.message },
                'file watcher failed; it restarts on the next lane change',
              );
              unwatch(root);
            },
          );
          watched.set(root, { projectId, batchId, root, handle });
        } catch (error) {
          deps.logger.warn({ projectId, root, err: String(error) }, 'could not watch the checkout');
        }
      }
    },

    async stepEnd(workstreamId) {
      const ws = getWorkstream(db, workstreamId);
      const project = getProject(db, ws.projectId);
      const root = checkoutOf(db, ws);
      if (!existsSync(root)) return [];
      const batchId = worktreeBatchOf(ws);
      const changed = withoutBookkeeping(ws.projectId, root, await deps.git.changedPaths(root));
      const { strays, candidates } = straysIn(
        project,
        batchId,
        changed,
        STEP_END_CLAIM_STATES,
        workstreamId,
      );
      // A write that can change what runs is flagged even inside the workstream's own claim.
      const flagged = [...new Set([...strays, ...changed.filter(isSensitivePath)])];
      raise(project, siteOf(project, batchId, root), flagged, candidates, workstreamId);
      return flagged;
    },

    flush,

    stop() {
      stopped = true;
      unsubscribe();
      timer?.cancel();
      timer = null;
      for (const root of [...watched.keys()]) unwatch(root);
    },
  };
}
