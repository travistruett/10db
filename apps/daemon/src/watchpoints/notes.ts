import {
  EvidenceKind,
  McpToolName,
  McpToolOutputs,
  StepRole,
  type EvidenceDto,
  type WatchpointDetail,
  type WatchpointFileView,
  type WatchpointHitsDto,
  type WatchpointNote,
  type WorkstreamId,
  type WorkstreamStep,
} from '@10db/contracts';
import { listToolOpResults, type DbReader } from '@10db/db';

/** The newest note per path: a later note for a path replaces an earlier one. */
function newestPerPath(notes: readonly WatchpointNote[]): Map<string, string> {
  return new Map(notes.map((n) => [n.path, n.note]));
}

/** The agent's reason per file, from every commit of the run, the newest commit winning per path. */
export function agentNotesOf(db: DbReader, workstreamId: WorkstreamId): Map<string, string> {
  return newestPerPath(
    listToolOpResults(db, workstreamId, McpToolName.Commit).flatMap((result) => {
      const parsed = McpToolOutputs.commit.safeParse(result);
      return parsed.success ? parsed.data.watchpointNotes : [];
    }),
  );
}

const CHECKING_ROLES: readonly StepRole[] = [StepRole.Review, StepRole.Qa];

/**
 * The reviewer's check per file, from the Review and QA steps in order, each step's earlier rounds before its
 * latest result, the newest note winning per path, so the final diff keeps a Reviewer line.
 */
export function reviewerNotesOf(steps: readonly WorkstreamStep[]): Map<string, string> {
  return newestPerPath(
    steps.flatMap((s) =>
      CHECKING_ROLES.includes(s.role)
        ? [...s.earlier, ...(s.result === null ? [] : [s.result])].flatMap(
            (r) => r.watchpointNotes ?? [],
          )
        : [],
    ),
  );
}

/** The newest watchpoint evidence row, which is the current reading of the run's change. */
export function newestWatchpointRow(
  evidence: readonly EvidenceDto[],
): Extract<EvidenceDto, { kind: typeof EvidenceKind.Watchpoint }> | null {
  return (
    evidence
      .filter((e): e is Extract<EvidenceDto, { kind: typeof EvidenceKind.Watchpoint }> => {
        return e.kind === EvidenceKind.Watchpoint;
      })
      .at(-1) ?? null
  );
}

/** A reading's hits with the notes written about each file joined on. */
export function withNotes(
  detail: WatchpointDetail,
  notes: {
    readonly agent: ReadonlyMap<string, string>;
    readonly reviewer: ReadonlyMap<string, string>;
  },
): WatchpointHitsDto['hits'] {
  return detail.hits.map((hit) => ({
    watchpoint: hit.watchpoint,
    files: hit.files.map((file): WatchpointFileView => ({
      ...file,
      agentNote: notes.agent.get(file.path) ?? null,
      reviewerNote: notes.reviewer.get(file.path) ?? null,
    })),
  }));
}
