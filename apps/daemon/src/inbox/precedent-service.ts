import {
  NotFoundError,
  PrecedentState,
  type PrecedentAnswer,
  type PrecedentCandidateDto,
  type PrecedentPatch,
  type PrecedentScope,
  type ProjectDto,
  type ProjectId,
  type ProjectPrecedentsDto,
  type TrustPrecedentDto,
  type TrustPrecedentId,
} from '@10db/contracts';
import {
  approvePrecedent,
  findOpenByFoldKey,
  getProject,
  lastAllowedByPrecedent,
  listPrecedents,
  listProjects,
  setPrecedent,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { CommittedReader } from '../folders';
import type { Logger } from '../log';
import { PRECEDENT_REFRESH_MS, precedentCandidates, type PrecedentEvents } from '../trust';
import {
  applyPrecedentAnswer,
  postPrecedentChanged,
  precedentFoldKey,
  raisePrecedentConflict,
  refreshPrecedentCard,
  resolvePrecedentConflict,
} from './precedent-card';

/** How many of a precedent's last allowed calls Settings lists. */
const LAST_ALLOWED_SHOWN = 5;

export interface PrecedentService {
  /** Every precedent of the project in every state, and the kinds on offer. */
  list(projectId: ProjectId): Promise<ProjectPrecedentsDto>;
  /** The builder's answer to the proposal card, written with the card's rewording in one write. */
  answer(projectId: ProjectId, answer: PrecedentAnswer): Promise<ProjectPrecedentsDto>;
  /** `active` approves again from any state; `revoked`, a new kind or a kept hash change the row. */
  patch(
    projectId: ProjectId,
    id: TrustPrecedentId,
    change: PrecedentPatch,
  ): Promise<TrustPrecedentDto>;
  /** Computes the project's candidates, then rewords, raises or resolves its card; calls close up behind a running one. */
  refresh(projectId: ProjectId): Promise<void>;
  /** After Run and Make Routine: stores the committed text's hash on kinds approved without one. Never rejects. */
  settleHashes(
    projectId: ProjectId,
    kinds: readonly { readonly programKey: string; readonly scope: PrecedentScope }[],
  ): Promise<void>;
  /** Every project once now, then each project with an open card every `PRECEDENT_REFRESH_MS`. */
  start(): void;
  stop(): void;
  /** What a session tells the daemon; each is bookkeeping and never throws. */
  readonly events: PrecedentEvents;
}

/**
 * Standing approvals' services: candidates computed on demand and on a schedule, the proposal card they feed, and
 * the answers that write precedent rows. A refresh computes the candidates first and writes second, and the write
 * drops every kind that has a row, so a slow one never re-offers a kind answered meanwhile.
 */
export function createPrecedentService(deps: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly log: Logger;
  /** Reads a project's files as committed on its base; null shows the card no recipe. */
  readonly readerFor: (project: ProjectDto) => CommittedReader | null;
}): PrecedentService {
  const db = deps.state.db;
  const candidatesOf = (projectId: ProjectId): Promise<PrecedentCandidateDto[]> => {
    const project = getProject(db, projectId);
    return precedentCandidates(db, projectId, deps.clock.now(), deps.readerFor(project));
  };

  const viewOf = (
    projectId: ProjectId,
    candidates: readonly PrecedentCandidateDto[],
  ): ProjectPrecedentsDto => {
    const rows = listPrecedents(db, projectId);
    return {
      precedents: rows.map((row) => ({
        ...row,
        lastAllowed: lastAllowedByPrecedent(db, row.id, LAST_ALLOWED_SHOWN),
      })),
      candidates: candidates.filter(
        (c) => !rows.some((r) => r.programKey === c.programKey && r.scope === c.scope),
      ),
    };
  };

  const inFlight = new Map<ProjectId, Promise<void>>();
  const again = new Set<ProjectId>();
  const refresh = (projectId: ProjectId): Promise<void> => {
    const running = inFlight.get(projectId);
    if (running !== undefined) {
      again.add(projectId);
      return running;
    }
    const run = (async () => {
      do {
        again.delete(projectId);
        const candidates = await candidatesOf(projectId);
        deps.state.write((ctx) => {
          refreshPrecedentCard(ctx, projectId, candidates);
        });
      } while (again.has(projectId));
    })().finally(() => {
      inFlight.delete(projectId);
    });
    inFlight.set(projectId, run);
    return run;
  };
  const refreshQuietly = (projectId: ProjectId): void => {
    refresh(projectId).catch((error: unknown) => {
      deps.log.warn({ err: error, projectId }, 'the standing approvals card was not refreshed');
    });
  };

  let timer: Timer | null = null;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    for (const project of listProjects(db))
      if (findOpenByFoldKey(db, project.id, precedentFoldKey(project.id)) !== undefined)
        refreshQuietly(project.id);
    timer = deps.clock.setTimeout(tick, PRECEDENT_REFRESH_MS);
  };

  return {
    async list(projectId) {
      return viewOf(projectId, await candidatesOf(projectId));
    },
    async answer(projectId, answer) {
      const candidates = await candidatesOf(projectId);
      deps.state.write((ctx) => applyPrecedentAnswer(ctx, projectId, answer, candidates));
      return viewOf(projectId, candidates);
    },
    async patch(projectId, id, change) {
      getProject(db, projectId);
      const row = listPrecedents(db, projectId).find((r) => r.id === id);
      if (row === undefined) throw new NotFoundError('precedent', id);
      const returning =
        row.state === PrecedentState.Declined || row.state === PrecedentState.Revoked;
      // A kind brought back is approved with what the judge keeps doubting now; others keep what they hold.
      const fresh =
        change.state === PrecedentState.Active && returning
          ? (await candidatesOf(projectId)).find(
              (c) => c.programKey === row.programKey && c.scope === row.scope,
            )
          : undefined;
      return deps.state.write((ctx) => {
        if (change.state === PrecedentState.Active) {
          const approved = approvePrecedent(ctx, {
            projectId,
            programKey: row.programKey,
            scope: row.scope,
            kind: change.kind ?? row.kind,
            examples: fresh?.examples ?? row.examples,
            runsHash: change.runsHash ?? fresh?.runsHash ?? row.runsHash,
            state: PrecedentState.Active,
            sourceInboxId: null,
          });
          resolvePrecedentConflict(ctx, projectId, id, 'You approved it in Settings.');
          return approved;
        }
        const changed = setPrecedent(ctx, projectId, id, {
          ...(change.state === undefined ? {} : { state: change.state }),
          ...(change.kind === undefined ? {} : { kind: change.kind }),
          ...(change.runsHash === undefined ? {} : { runsHash: change.runsHash }),
        });
        if (changed === null) throw new NotFoundError('precedent', id);
        if (change.state === PrecedentState.Revoked)
          resolvePrecedentConflict(ctx, projectId, id, 'You removed it in Settings.');
        return changed;
      });
    },
    refresh,
    async settleHashes(projectId, kinds) {
      try {
        const candidates = await candidatesOf(projectId);
        deps.state.write((ctx) => {
          for (const row of listPrecedents(ctx.tx, projectId)) {
            if (row.runsHash !== null || row.state !== PrecedentState.Active) continue;
            if (!kinds.some((k) => k.programKey === row.programKey && k.scope === row.scope))
              continue;
            const hash = candidates.find(
              (c) => c.programKey === row.programKey && c.scope === row.scope,
            )?.runsHash;
            if (hash !== null && hash !== undefined)
              setPrecedent(ctx, projectId, row.id, { runsHash: hash });
          }
        });
      } catch (error) {
        deps.log.warn({ err: error, projectId }, 'the hash of a kind made routine was not stored');
      }
    },
    start() {
      stopped = false;
      for (const project of listProjects(db)) refreshQuietly(project.id);
      timer = deps.clock.setTimeout(tick, PRECEDENT_REFRESH_MS);
    },
    stop() {
      stopped = true;
      timer?.cancel();
      timer = null;
    },
    events: {
      paused(projectId, id) {
        try {
          deps.state.write((ctx) => {
            raisePrecedentConflict(ctx, projectId, id);
          });
        } catch (error) {
          deps.log.warn(
            { err: error, projectId, precedentId: id },
            'the conflict card was not raised',
          );
        }
      },
      changed(projectId, id, hash) {
        try {
          deps.state.write((ctx) => {
            const row = listPrecedents(ctx.tx, projectId).find((r) => r.id === id);
            if (row !== undefined) postPrecedentChanged(ctx, projectId, row, hash);
          });
        } catch (error) {
          deps.log.warn(
            { err: error, projectId, precedentId: id },
            'the changed notice was not posted',
          );
        }
      },
      doubtSkip: refreshQuietly,
    },
  };
}
