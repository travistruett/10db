import { existsSync, statSync, watch as fsWatch } from 'node:fs';
import { join, sep } from 'node:path';
import {
  ACTIVE_STATES,
  LANE_STATES,
  WorkstreamState,
  type ProjectDto,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import { activeClaims, getProject, getWorkstream, listWorkstreams } from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Git } from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import {
  bulkFoldKey,
  findForeignClaimWrites,
  findStrays,
  foreignBulkFoldKey,
  isAlwaysIgnored,
  isSensitivePath,
  type ClaimHolder,
  STRAY_BULK_THRESHOLD,
  strayFoldKey,
} from './strays';

const WATCH_BATCH_MS = 500;
const BULK_LISTED = 20;
const WATCHED_STATES = [...LANE_STATES, WorkstreamState.WaitingHuman];

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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface Watcher {
  /** Watches every project with active work and stops watching the rest. */
  sync(): void;
  /** Diffs git status against the claims after a session; returns the strays it flagged. */
  stepEnd(workstreamId: WorkstreamId): Promise<string[]>;
  /** Processes pending changes now instead of at the next batch. */
  flush(): Promise<void>;
  stop(): void;
}

export function createWatcher(deps: {
  readonly state: StateStore;
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
  const watched = new Map<
    ProjectId,
    { readonly root: string; readonly handle: { close(): void } }
  >();
  const pending = new Map<ProjectId, Set<string>>();
  let timer: Timer | null = null;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  const activeIn = (projectId: ProjectId) =>
    listWorkstreams(db, { states: WATCHED_STATES, projectId });

  function unwatch(projectId: ProjectId): void {
    watched.get(projectId)?.handle.close();
    watched.delete(projectId);
    pending.delete(projectId);
  }

  function enqueue(projectId: ProjectId, rel: string): void {
    if (stopped || rel === '' || isAlwaysIgnored(rel)) return;
    const set = pending.get(projectId) ?? new Set<string>();
    set.add(rel);
    pending.set(projectId, set);
    timer ??= deps.clock.setTimeout(() => {
      timer = null;
      void flush();
    }, batchMs);
  }

  function raise(
    project: ProjectDto,
    strays: readonly string[],
    candidates: readonly WorkstreamId[],
    owner: WorkstreamId | null,
  ): void {
    if (strays.length === 0) return;
    const workstreamId = owner ?? (candidates.length === 1 ? (candidates[0] ?? null) : null);
    if (strays.length > STRAY_BULK_THRESHOLD) {
      const listed = strays.slice(0, BULK_LISTED);
      deps.inbox.flag({
        projectId: project.id,
        workstreamId,
        title: `${String(strays.length)} writes outside every claim`,
        body: `${listed.join('\n')}\n…and ${String(strays.length - listed.length)} more`,
        detail: { count: strays.length, paths: listed, candidates: [...candidates] },
        foldKey: bulkFoldKey(project.id),
      });
      return;
    }
    for (const rel of strays) {
      deps.inbox.flag({
        projectId: project.id,
        workstreamId,
        title: 'Write outside every claim',
        body: rel,
        detail: { path: rel, candidates: [...candidates] },
        foldKey: strayFoldKey(project.id, rel),
      });
    }
  }

  /** Strays among `paths` against every active claim in the project. */
  function straysIn(
    project: ProjectDto,
    paths: readonly string[],
  ): { strays: string[]; candidates: WorkstreamId[] } {
    const active = activeIn(project.id);
    // A parked or queued workstream still holds its claims, so a write inside them isn't outside every claim.
    const holders = listWorkstreams(db, { states: ACTIVE_STATES, projectId: project.id });
    const claims = holders.flatMap((ws) =>
      activeClaims(db, ws.id).map((c) => ({ kind: c.kind, name: c.name })),
    );
    return { strays: findStrays(paths, project, claims), candidates: active.map((ws) => ws.id) };
  }

  /** Writes inside a claim whose holder isn't running, attributed to the sessions that are. */
  function raiseForeign(project: ProjectDto, paths: readonly string[]): void {
    if (paths.length === 0) return;
    const holders: ClaimHolder[] = listWorkstreams(db, {
      states: ACTIVE_STATES,
      projectId: project.id,
    }).map((ws) => ({
      id: ws.id,
      running: ws.state === WorkstreamState.Running,
      claims: activeClaims(db, ws.id).map((c) => ({ kind: c.kind, name: c.name })),
    }));
    const foreign = findForeignClaimWrites(paths, project, holders);
    if (foreign.length === 0) return;
    const running = holders.filter((h) => h.running).map((h) => h.id);
    const workstreamId = running.length === 1 ? (running[0] ?? null) : null;
    if (foreign.length > STRAY_BULK_THRESHOLD) {
      const listed = foreign.slice(0, BULK_LISTED).map((f) => f.path);
      deps.inbox.flag({
        projectId: project.id,
        workstreamId,
        title: `${String(foreign.length)} writes inside another workstream's claim`,
        body: `${listed.join('\n')}\n…and ${String(foreign.length - listed.length)} more`,
        detail: { count: foreign.length, paths: listed, candidates: running },
        foldKey: foreignBulkFoldKey(project.id),
      });
      return;
    }
    for (const { path, holders: claimedBy } of foreign) {
      deps.inbox.flag({
        projectId: project.id,
        workstreamId,
        title: "Write inside another workstream's claim",
        body: path,
        detail: { path, candidates: running, claimedBy },
        foldKey: strayFoldKey(project.id, path),
      });
    }
  }

  async function processBatch(projectId: ProjectId, paths: readonly string[]): Promise<void> {
    const entry = watched.get(projectId);
    if (!entry) return;
    if (!existsSync(entry.root)) {
      deps.logger.warn({ projectId }, 'the watched repository is gone; stopped watching it');
      unwatch(projectId);
      return;
    }
    // Only what git still sees as changed now. This drops ignored files and directories. It also drops files
    // already committed through 10db's claim-checked commit, whose claims may have been released since the write.
    const changed = new Set((await deps.git.status(entry.root)).map((s) => s.path));
    const project = getProject(db, projectId);
    const reported = paths.filter((rel) => changed.has(rel));
    const { strays, candidates } = straysIn(project, reported);
    // Ignored or unreported paths that can change what runs are flagged whatever the claims say.
    const hidden = paths.filter(
      (rel) => !changed.has(rel) && isSensitivePath(rel) && isFile(join(entry.root, rel)),
    );
    raise(project, [...strays, ...hidden], candidates, null);
    const outside = new Set(strays);
    raiseForeign(
      project,
      reported.filter((rel) => !outside.has(rel)),
    );
  }

  async function processPending(): Promise<void> {
    const batches = [...pending.entries()].map(([id, set]) => [id, [...set].sort()] as const);
    pending.clear();
    for (const [projectId, paths] of batches) {
      try {
        await processBatch(projectId, paths);
      } catch (error) {
        deps.logger.warn({ projectId, err: String(error) }, 'watcher batch failed');
      }
    }
  }

  function flush(): Promise<void> {
    timer?.cancel();
    timer = null;
    chain = chain.then(processPending);
    return chain;
  }

  return {
    sync() {
      if (stopped) return;
      const wanted = new Map<ProjectId, string>();
      for (const ws of listWorkstreams(db, { states: WATCHED_STATES })) {
        if (!wanted.has(ws.projectId))
          wanted.set(ws.projectId, getProject(db, ws.projectId).repoPath);
      }
      for (const projectId of [...watched.keys()]) if (!wanted.has(projectId)) unwatch(projectId);
      for (const [projectId, root] of wanted) {
        if (watched.has(projectId) || !existsSync(root)) continue;
        try {
          const handle = watch(
            root,
            (rel) => {
              enqueue(projectId, rel);
            },
            (error) => {
              deps.logger.warn(
                { projectId, err: error.message },
                'file watcher failed; it restarts on the next lane change',
              );
              unwatch(projectId);
            },
          );
          watched.set(projectId, { root, handle });
        } catch (error) {
          deps.logger.warn({ projectId, err: String(error) }, 'could not watch the repository');
        }
      }
    },

    async stepEnd(workstreamId) {
      const ws = getWorkstream(db, workstreamId);
      const project = getProject(db, ws.projectId);
      if (!existsSync(project.repoPath)) return [];
      const changed = (await deps.git.status(project.repoPath))
        .map((s) => s.path)
        .filter((rel) => !isAlwaysIgnored(rel));
      const { strays, candidates } = straysIn(project, changed);
      raise(project, strays, candidates, workstreamId);
      return strays;
    },

    flush,

    stop() {
      stopped = true;
      timer?.cancel();
      timer = null;
      for (const projectId of [...watched.keys()]) unwatch(projectId);
    },
  };
}
