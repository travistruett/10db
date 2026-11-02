import { existsSync, lstatSync, readdirSync, watch as fsWatch, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
  getAppSetting,
  getBatch,
  getProject,
  getWorkstream,
  getWorkstreamRow,
  listInbox,
  listPermissionRules,
  listProjects,
  listWorkstreamCommitShas,
  listWorkstreams,
  setAppSetting,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import { checkoutOf } from '../delivery';
import type { EventBus, StateStore } from '../events';
import {
  bookkeepingAt,
  existsAsEntry,
  GitTrustError,
  ignoredBookkeepingWrite,
  isInsideClaudeCodeBookkeeping,
  type Git,
} from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import {
  ANSWERED_CARDS_READ,
  ANSWERED_STATES,
  cardAllowances,
  cardUseKeys,
  isDeletionStamp,
  relativeIn,
  ruleAllowances,
  stampMatchesExpected,
  stampOrReason,
  writeStamp,
} from './allowed-writes';
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
/** The app setting that holds the writes a permission card excused, so a restart keeps them. */
const EXCUSED_WRITES_SETTING = 'watcher.excusedWrites';
/** A write a lane's permission card allowed, as it looked when excused. */
interface ExcusedWrite {
  /** The write's modification time, size and content hash, or a deletion's stamp (`writeStamp`). */
  readonly stamp: string;
  /** The only lane it excuses. */
  readonly workstreamId: WorkstreamId;
  /** The card use that excused it. */
  readonly useKey: string;
}
/** The most excused writes kept; the oldest go first. */
const MAX_EXCUSED_WRITES = 500;
/** The most files a sensitive directory may hold and still be read as the base's own; more cards it. */
const MAX_DIR_FILES = 500;
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
/** The title of a single stray card, or of a bulk one: "<n> writes outside every claim". */
const isStrayTitle = (title: string): boolean =>
  title === STRAY_TITLE || /^\d+ writes outside every claim$/.test(title);

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

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
  // Work queued per checkout (`onRoot`), keyed by the checkout's path; a checkout with nothing queued has none.
  const queues = new Map<string, Promise<void>>();
  // Checkouts with a batch run queued that has not started yet; it takes the checkout's `pending` when it does.
  const waiting = new Set<string>();
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

  /** The recent answered Allow Edit cards that allowed one write, oldest first. */
  const answeredEditCards = (projectId: ProjectId) =>
    cardAllowances(
      listInbox(db, { states: [...ANSWERED_STATES], projectId, recent: ANSWERED_CARDS_READ }),
    ).reverse();

  // The allow-once cards a write has used, so one card excuses one write; the cards answered before this
  // watcher started are used up, since they allowed writes it never saw. Each project's own latest answered
  // cards are read, as allowedWrites reads them; a read across every project could miss a card that is old
  // among all of them yet still among its own project's latest.
  // A folded card allows one write for each lane it targets, so a use is a card and a lane.
  // The allow-once cards that excused a write whose file was still changing, without being used: a second
  // such write under the same card is carded (allowedWrites).
  const settling = new Set<string>();
  const usedCards = new Set<string>(
    listProjects(db).flatMap((p) =>
      cardUseKeys(
        listInbox(db, {
          states: [...ANSWERED_STATES],
          projectId: p.id,
          recent: ANSWERED_CARDS_READ,
        }),
      ),
    ),
  );
  // The write each excused path last showed for the lane whose card excused it, by checkout, path and lane: a
  // write seen again unchanged, in a later batch, is the one its card already excused, and a different one
  // is not. It excuses nothing for another lane, and goes when its lane's run ends.
  // Kept in the database too, so a restarted daemon still excuses the write a card allowed before it: the
  // cards answered before it started count as used, which alone would card that write again at the step end.
  const excusedWrites = loadExcusedWrites();

  function loadExcusedWrites(): Map<string, ExcusedWrite> {
    const stored = getAppSetting(db, EXCUSED_WRITES_SETTING);
    const map = new Map<string, ExcusedWrite>();
    if (!Array.isArray(stored)) return map;
    for (const entry of stored) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const value: unknown = entry[1];
      if (typeof value !== 'object' || value === null) continue; // an entry with no lane excuses nobody
      const { stamp, workstreamId, useKey } = value as Record<string, unknown>;
      const lane = WorkstreamId.safeParse(workstreamId);
      if (typeof stamp !== 'string' || !lane.success || typeof useKey !== 'string') continue;
      map.set(entry[0], { stamp, workstreamId: lane.data, useKey });
    }
    return map;
  }

  function persistExcusedWrites(): void {
    deps.state.write((ctx) => {
      setAppSetting(
        ctx,
        EXCUSED_WRITES_SETTING,
        [...excusedWrites].map(([key, { stamp, workstreamId, useKey }]) => [
          key,
          { stamp, workstreamId, useKey },
        ]),
      );
    });
  }

  /** What names a lane's excused write to `path` in `root`. */
  const excusedKey = (root: string, path: string, lane: WorkstreamId): string =>
    `${root}\0${path}\0${lane}`;

  /** Records that `write` was excused, keeping the latest few entries. */
  function excuse(key: string, write: ExcusedWrite): void {
    excusedWrites.delete(key);
    excusedWrites.set(key, write);
    while (excusedWrites.size > MAX_EXCUSED_WRITES) {
      const oldest = excusedWrites.keys().next();
      if (oldest.done) break;
      excusedWrites.delete(oldest.value);
    }
    persistExcusedWrites();
  }

  /**
   * Forgets the excused writes of every lane whose run is over (done, failed or cancelled) or that is gone.
   * A lane still mid-run keeps its own, in every state it passes through between sessions: QUEUED between
   * steps and after a send-back or a restart's recovery, RECOVERING, PAUSED_LIMIT.
   */
  function forgetEndedLanes(): void {
    if (excusedWrites.size === 0) return;
    const active = new Set(listWorkstreams(db, { states: ACTIVE_STATES }).map((ws) => ws.id));
    let forgot = false;
    for (const [key, write] of excusedWrites) {
      if (active.has(write.workstreamId)) continue;
      excusedWrites.delete(key);
      forgot = true;
    }
    if (forgot) persistExcusedWrites();
  }

  /**
   * Forgets each excused deletion in `root` whose file is there again (of `paths` only, when given): the
   * deletion it excused is undone, so a later one is another write its card never allowed.
   */
  function forgetRestored(root: string, paths?: readonly string[]): void {
    if (excusedWrites.size === 0) return;
    const named = paths === undefined ? null : new Set(paths);
    let forgot = false;
    for (const [key, write] of excusedWrites) {
      if (!isDeletionStamp(write.stamp)) continue;
      const [keyRoot = '', path = ''] = key.split('\0');
      if (keyRoot !== root || (named !== null && !named.has(path))) continue;
      if (!existsAsEntry(join(root, path))) continue;
      excusedWrites.delete(key);
      forgot = true;
    }
    if (forgot) persistExcusedWrites();
  }

  /**
   * The paths among `paths` that a permission card, or a rule one stored, allowed a lane among `lanes` to
   * write in `root`: the builder decided about that exact write when they answered its Allow Edit card, so
   * the stray-write card would only repeat it. An allow-once card excuses the next write to its file and
   * is then used, and its write's stamp recorded for the card's lane; a later write no card allowed still
   * cards. The live batch and the step end both go through here, so a write excused by one is excused
   * unchanged by the other (a deletion while the file stays gone), and a later write the live batch never
   * saw is carded at the step end.
   */
  async function allowedWrites(
    projectId: ProjectId,
    root: string,
    paths: readonly string[],
    lanes: readonly WorkstreamId[],
  ): Promise<Set<string>> {
    const allowed = new Set<string>();
    if (paths.length === 0 || lanes.length === 0) return allowed;
    forgetEndedLanes();
    const inScope = (a: { workstreamId: WorkstreamId | null }) =>
      a.workstreamId !== null && lanes.includes(a.workstreamId);
    const named = <T extends { path: string }>(list: readonly T[]) =>
      list.flatMap((a) => {
        const rel = relativeIn(root, a.path);
        return rel === null ? [] : [{ rel, a }];
      });
    const cards = named(answeredEditCards(projectId).filter(inScope));
    const standing = [
      ...cards.filter(({ a }) => a.standing),
      ...named(lanes.flatMap((id) => ruleAllowances(listPermissionRules(db, projectId, id)))),
    ];
    const keysOf = (path: string): string[] =>
      lanes.map((l) => excusedKey(root, path, l)).filter((k) => excusedWrites.has(k));
    const unusedCardsOf = (path: string) =>
      cards.filter(
        ({ rel, a }) =>
          rel === path && !a.standing && a.useKey !== null && !usedCards.has(a.useKey),
      );
    // Reading a file to stamp it costs its whole content, so only a path a card or an excused write names
    // is read; any other write is carded as it is. The reads run together, each within its time budget, so
    // a batch waits for its slowest file and no longer than that; the decisions below then run without
    // awaiting, one path after the other.
    const reads = new Map(
      await Promise.all(
        paths
          .filter(
            (p) =>
              !standing.some(({ rel }) => rel === p) &&
              (keysOf(p).length > 0 || unusedCardsOf(p).length > 0),
          )
          .map(async (p) => [p, await stampOrReason(root, p)] as const),
      ),
    );
    for (const path of paths) {
      if (standing.some(({ rel }) => rel === path)) {
        allowed.add(path);
        continue;
      }
      // The decision is made against the excused writes and cards as they are now, not as they were before
      // the reads: another checkout's batch may have used a card or excused a write meanwhile.
      if (keysOf(path).length === 0 && unusedCardsOf(path).length === 0) continue;
      const read = reads.get(path) ?? (await stampOrReason(root, path));
      const keys = keysOf(path);
      const unusedCards = unusedCardsOf(path);
      if (keys.length === 0 && unusedCards.length === 0) continue;
      const stamp = 'stamp' in read ? read.stamp : null;
      if (stamp !== null && keys.some((k) => excusedWrites.get(k)?.stamp === stamp)) {
        allowed.add(path);
        continue;
      }
      if (stamp !== null && keys.length > 0) {
        // The file holds another write now: the one each entry excused is gone for good.
        for (const k of keys) excusedWrites.delete(k);
        persistExcusedWrites();
      }
      // A card that records the file its lane's allowed call makes excuses only that exact file: the watcher
      // can't tell which lane wrote it, but another lane's write to the same path is not what the builder
      // approved, and it leaves the card unused for the write that is. A card that asks for that exact write
      // with none recorded (a NotebookEdit, a file the broker couldn't read) excuses no settled write. A file
      // with no stamp goes on to the fail-closed handling below, which checks the write once it settles.
      const unused = unusedCards.find(
        ({ a }) =>
          a.expected === undefined ||
          (stamp === null
            ? a.expected !== null
            : a.expected !== null && stampMatchesExpected(stamp, a.expected)),
      );
      const lane = unused?.a.workstreamId;
      const use = unused?.a.useKey;
      if (lane == null || use == null) continue;
      if (stamp === null) {
        // A write that can't be told apart from the next one fails closed, so the card never excuses writes
        // without end: a path that can't be read, or is not a regular file (a directory, a link to one), is
        // carded and leaves the card unused; a file still changing is excused once without using the card,
        // which then excuses that write when it settles, and a second time it is still unsettled it is carded.
        if (!('reason' in read) || read.reason !== 'changing' || settling.has(use)) continue;
        settling.add(use);
        allowed.add(path);
        continue;
      }
      settling.delete(use);
      usedCards.add(use);
      // A deletion is remembered by its directory's stamp, which excuses it only while the file stays gone
      // and nothing else is added to or removed from that directory (forgetRestored, deletionStamp).
      excuse(excusedKey(root, path, lane), { stamp, workstreamId: lane, useKey: use });
      allowed.add(path);
    }
    return allowed;
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
   * Sensitive paths stay carded. A bulk card resolves only when every path it lists is covered and not
   * sensitive and, when it lists fewer than it counts, nothing changed since the lane's base lies outside
   * every claim in the checkout (the lane's own and other watched lanes'), since the paths it leaves out
   * can't be read from the card. What counts as changed is the uncommitted changes plus the files of the
   * commits the lane itself made through the commit tool; the builder's commits, merges, pulls and other
   * lanes' commits are left out. The listed paths need the lane's own claims.
   */
  async function resolveCovered(lane: WorkstreamId): Promise<void> {
    if (stopped) return;
    const ws = getWorkstream(db, lane);
    const open = listInbox(db, { states: [InboxState.Open], projectId: ws.projectId }).filter(
      (item) => item.kind === InboxKind.Flag && isStrayTitle(item.title) && names(item, lane),
    );
    if (open.length === 0) return;
    const project = getProject(db, ws.projectId);
    const root = checkoutOf(db, ws);
    const site = siteOf(project, worktreeBatchOf(ws), root);
    // Every claim the lane holds counts in its own checkout, the one its per-copy claims are scoped to.
    const claims = activeClaims(db, lane).map((c) => ({ kind: c.kind, name: c.name }));
    const covered = (paths: readonly string[]): boolean =>
      paths.every((p) => !isSensitivePath(p)) && findStrays(paths, project, claims).length === 0;
    let unlistedCovered: boolean | null = null;
    /**
     * Whether nothing the lane has changed since its base lies outside the claims, bar the sensitive paths
     * with cards of their own. The lane's own commits count: a write it committed through the commit tool
     * is gone from the working tree's status but is still a write outside every claim. A lane with no
     * recorded base has run no session, so its HEAD is the base.
     */
    const noStraysNow = async (): Promise<boolean> => {
      if (unlistedCovered !== null) return unlistedCovered;
      try {
        const base = getWorkstreamRow(db, lane).baseHead ?? 'HEAD';
        // Counted: every uncommitted change in the checkout, since an uncommitted write has no author, and the
        // files of the commits this lane made through the commit tool (its recorded commits, each carrying a
        // 10db-Op trailer). Left out: every other commit since the base, whether the builder made it, a merge
        // or pull brought it in, or another lane committed it through the commit tool. None of those is this
        // lane's to answer for, and whether a path counts as covered must not hang on whether the lane that
        // committed it still holds its claim. A path another watched lane's claim covers counts as covered.
        const mine = new Set(listWorkstreamCommitShas(db, lane));
        const ownCommits = (await deps.git.commitsSince(root, base)).filter((sha) => mine.has(sha));
        const committed = await Promise.all(
          ownCommits.map((sha) => deps.git.filesChangedBetween(root, `${sha}^`, sha)),
        );
        const changed = withoutBookkeeping(ws.projectId, root, [
          ...new Set([...committed.flat(), ...(await deps.git.changedPaths(root))]),
        ]);
        unlistedCovered =
          straysIn(
            project,
            worktreeBatchOf(ws),
            changed.filter((p) => !isSensitivePath(p)),
            WATCHED_STATES,
            lane,
          ).strays.length === 0;
      } catch {
        unlistedCovered = false;
      }
      return unlistedCovered;
    };
    for (const item of open) {
      if (item.title === STRAY_TITLE) {
        const path = item.detail?.['path'];
        if (typeof path !== 'string' || !covered([path])) continue;
        if (item.body !== labelled(site, path)) continue;
        deps.inbox.resolve(item.id, 'The lane it names now holds a claim covering it.');
        continue;
      }
      const listed = item.detail?.['paths'];
      const count = item.detail?.['count'];
      if (!Array.isArray(listed) || listed.length === 0 || typeof count !== 'number') continue;
      if (!listed.every((p): p is string => typeof p === 'string') || !covered(listed)) continue;
      const lines = listed.map((p) => labelled(site, p));
      if (!item.body.startsWith(lines.join('\n'))) continue;
      if (count > listed.length && !(await noStraysNow())) continue;
      deps.inbox.resolve(item.id, 'The lane it names now holds a claim covering every write.');
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

  /**
   * The commits 10db merges into a batch's copy from: the base branch as last fetched (base-update merges
   * `refs/remotes/origin/<base>`, and fast-forwards to it when the branch has nothing of its own), and the
   * base the batch records once merged. None for the main checkout, which 10db never merges into.
   */
  function incomingBases(batchId: BatchId | null): string[] {
    if (batchId === null) return [];
    const batch = getBatch(db, batchId);
    const bases = [`refs/remotes/origin/${batch.baseBranch}`];
    if (batch.baseSha !== null) bases.push(batch.baseSha);
    return bases;
  }

  /** Whether HEAD holds `rel` as a regular file with the very blob one of `bases` holds there. */
  async function sameAsBase(root: string, rel: string, bases: readonly string[]): Promise<boolean> {
    const head = await deps.git.blobAt(root, 'HEAD', rel).catch(() => null);
    if (head === null) return false;
    for (const base of bases)
      if ((await deps.git.blobAt(root, base, rel).catch(() => null)) === head) return true;
    return false;
  }

  /**
   * The files under directory `rel`, relative to the checkout, leaving out Claude Code's bookkeeping; null
   * when it holds anything but files and directories (a link, say) or more than `MAX_DIR_FILES` files.
   */
  function filesUnder(root: string, rel: string): string[] | null {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, rel), { recursive: true, withFileTypes: true });
    } catch {
      return null;
    }
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      const file = relative(root, join(entry.parentPath, entry.name)).split(sep).join('/');
      if (isInsideClaudeCodeBookkeeping(file)) continue;
      if (!entry.isFile() || files.length >= MAX_DIR_FILES) return null;
      files.push(file);
    }
    return files;
  }

  /**
   * Whether a sensitive path holds only what 10db's own base merge or fast-forward brought into the copy, so
   * no lane's write is left to card. A file qualifies when git doesn't report it as changed and HEAD's blob
   * for it is the incoming base's own: a file a lane committed (through the commit tool, before its batch
   * ran) has a blob no base holds, so it still cards, as does any edit, deletion or untracked or ignored
   * file (`.env`, `.git/config`). A directory qualifies when it holds at least one file, every file in it
   * qualifies, and git reports nothing under it. A path git can't be asked about stays flagged.
   */
  async function onlyFromBase(
    root: string,
    rel: string,
    changed: ReadonlySet<string>,
    bases: readonly string[],
  ): Promise<boolean> {
    if (bases.length === 0) return false;
    if (!isRealDirectory(join(root, rel)))
      return !changed.has(rel) && (await sameAsBase(root, rel, bases));
    const files = filesUnder(root, rel);
    if (files === null || files.length === 0) return false;
    const reported = await deps.git.changedPaths(root, [rel]).catch(() => null);
    if (reported === null || reported.length > 0) return false;
    for (const file of files) if (!(await sameAsBase(root, file, bases))) return false;
    return true;
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
    // Before git's filter, which drops a file restored as it was: an excused deletion ends when it comes back.
    forgetRestored(entry.root, allPaths);
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
    // A sensitive path holding only what 10db's own base merge brought into the copy is no lane's write.
    const hidden: string[] = [];
    const bases = incomingBases(batchId);
    for (const rel of paths) {
      if (changed.has(rel) && !isSensitivePath(rel)) continue;
      if (!isSensitivePath(rel) && !isInsideClaudeCodeBookkeeping(rel)) continue;
      if (isSensitivePath(rel) && (await onlyFromBase(entry.root, rel, changed, bases))) continue;
      if (!existsAsEntry(join(entry.root, rel))) continue;
      const bookkeeping = bookkeepingAt(entry.root, rel);
      if (bookkeeping.length > 0) logBookkeeping(projectId, entry.root, rel, bookkeeping);
      else if (isSensitivePath(rel)) hidden.push(rel);
    }
    const outside = new Set([...strays, ...hidden]);
    // A write the builder allowed through its permission card needs no second card.
    const allowed = await allowedWrites(projectId, entry.root, [...outside], candidates);
    // A directory the allowed write created holds only that write, so it is allowed with it.
    for (const rel of outside) {
      if (allowed.has(rel) || !isRealDirectory(join(entry.root, rel))) continue;
      const files = filesUnder(entry.root, rel);
      if (files === null || files.length === 0) continue;
      const fileAllowed = await allowedWrites(projectId, entry.root, files, candidates);
      if (files.every((f) => fileAllowed.has(f))) allowed.add(rel);
    }
    raise(
      project,
      site,
      [...outside].filter((rel) => !allowed.has(rel)),
      candidates,
      null,
    );
    raiseForeign(
      project,
      site,
      batchId,
      reported.filter((rel) => !outside.has(rel)),
    );
  }

  /**
   * Runs `work` after what is already queued for the checkout `root`. Each checkout has a queue of its own, so
   * a file that takes long to stamp holds up only the work behind it in its own checkout, never another
   * checkout's batches or another project's. With at most one batch waiting per checkout (see `flush`), work
   * queued there waits for at most the batch running and the one waiting, each bounded by the stamp budget.
   */
  function onRoot(root: string, work: () => Promise<void>): Promise<void> {
    const queued = (queues.get(root) ?? Promise.resolve()).then(work);
    queues.set(root, queued);
    void queued.then(() => {
      if (queues.get(root) === queued) queues.delete(root);
    });
    return queued;
  }

  /**
   * Queues a batch run for each checkout with pending changes, unless one is already waiting to start there.
   * The run takes the checkout's pending changes when it starts, so events that arrive while an earlier batch
   * is still running join the one waiting run: a checkout never holds more than one batch waiting.
   */
  function flush(): Promise<void> {
    timer?.cancel();
    timer = null;
    for (const root of pending.keys()) {
      if (waiting.has(root)) continue;
      waiting.add(root);
      void onRoot(root, async () => {
        waiting.delete(root);
        const set = pending.get(root);
        pending.delete(root);
        if (set === undefined) return;
        try {
          await processBatch(root, [...set].sort());
        } catch (error) {
          deps.logger.warn({ root, err: String(error) }, 'watcher batch failed');
        }
      });
    }
    // Settles when everything queued so far has, in every checkout.
    return Promise.all([...queues.values()]).then(() => undefined);
  }

  // Queued behind any batch in progress in the lane's checkout, so a card that batch raises is checked too;
  // outside the write that published the grant, since resolving a card is a write of its own. Only the lane
  // granted the claim can clear cards, and only its own.
  const unsubscribe =
    deps.bus?.subscribe((event) => {
      if (event.type !== EventType.ClaimAcquired || stopped) return;
      const lane = WorkstreamId.safeParse(event.data['workstreamId']);
      if (!lane.success) return;
      let root: string;
      try {
        root = checkoutOf(db, getWorkstream(db, lane.data));
      } catch (error) {
        deps.logger.warn({ err: String(error) }, 'could not re-check stray cards after a claim');
        return;
      }
      void onRoot(root, () =>
        resolveCovered(lane.data).catch((error: unknown) => {
          deps.logger.warn({ err: String(error) }, 'could not re-check stray cards after a claim');
        }),
      );
    }) ?? (() => undefined);

  return {
    sync() {
      if (stopped) return;
      forgetEndedLanes();
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
      // A file restored since its excused deletion is no longer in git's changes, so check every one here.
      forgetRestored(root);
      const changed = withoutBookkeeping(ws.projectId, root, await deps.git.changedPaths(root));
      const { strays, candidates } = straysIn(
        project,
        batchId,
        changed,
        STEP_END_CLAIM_STATES,
        workstreamId,
      );
      // A write that can change what runs is flagged even inside the workstream's own claim.
      const written = [...new Set([...strays, ...changed.filter(isSensitivePath)])];
      // Not a write its permission card allowed: the builder decided about that one already.
      const allowed = await allowedWrites(ws.projectId, root, written, [workstreamId]);
      // Nor a file still showing the write another running lane's card excused: a stamp that matches means
      // nobody has written to it since, so it is that lane's write and not this lane's to answer for. Only a
      // path another lane's excused write names is read (a huge file nobody excused costs nothing), and each
      // read is within the stamp time budget, so this step end never waits on a file longer than that.
      const others = listWorkstreams(db, { states: WATCHED_STATES, projectId: ws.projectId })
        .map((other) => other.id)
        .filter((id) => id !== workstreamId);
      const undecided = written.filter((rel) => !allowed.has(rel));
      const othersExcused = (rel: string): string[] =>
        others.flatMap((id) => {
          const stamp = excusedWrites.get(excusedKey(root, rel, id))?.stamp;
          return stamp === undefined ? [] : [stamp];
        });
      const stillOthers = new Set<string>();
      await Promise.all(
        undecided.map(async (rel) => {
          if (othersExcused(rel).length === 0) return;
          const stamp = await writeStamp(root, rel);
          if (stamp !== null && othersExcused(rel).includes(stamp)) stillOthers.add(rel);
        }),
      );
      const flagged = undecided.filter((rel) => !stillOthers.has(rel));
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
