import {
  PrecedentKind,
  PrecedentScope,
  ProgramKey,
  WorkstreamFailure,
  type LimitName,
  type PrecedentCandidateDto,
  type ProjectId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  approvedSkipIds,
  getProject,
  getWorkstreamRow,
  listDoubtSkips,
  listUnclearLimitCalls,
  type DbReader,
} from '@10db/db';
import type { CommittedReader } from '../folders';
import { callRuns, type CallRuns, type RunText } from './call-runs';
import { LIMIT_ORDER, LIMITS } from './limits';
import { keyPackageFile } from './program-key';
import { packageScriptLine, runsHash } from './precedents';

// Candidates for a standing approval are computed from what 10db's judge left doubtful, never stored: a key is
// offered when it keeps being doubted, and the card's write drops those that already have a row.

/** Doubtful calls of one key that make it a candidate. */
export const PRECEDENT_MIN_SKIPS = 3;
/** Runs those calls came from. */
export const PRECEDENT_MIN_RUNS = 2;
/** How far back the calls are read; a key with none newer leaves the card. */
export const PRECEDENT_WINDOW_DAYS = 14;
/** How often an open card is recomputed, which is what ends a kind that stopped being doubted. */
export const PRECEDENT_REFRESH_MS = 60 * 60_000;
/** How far back a stop at a named limit warns the builder. */
export const PRECEDENT_STOPPED_DAYS = 30;
/** The most kinds one card offers: an answer carries at most this many. */
export const PRECEDENT_CANDIDATES_MAX = 50;
/** The most calls shown as examples of a kind. */
const EXAMPLES_SHOWN = 5;
/** The most characters of what a kind runs that the card shows. */
const RUNS_SHOWN_MAX = 2000;
/** The most characters of a key the default kind line quotes. */
const KEY_IN_KIND_MAX = 150;

const DAY_MS = 86_400_000;

/** One doubtful call of a key: a skip of 10db's judge, or a call it sent to the second opinion. */
interface Occurrence {
  readonly key: string;
  readonly call: string | null;
  readonly workstreamId: WorkstreamId;
  readonly taskId: TaskId;
  readonly inCopy: boolean;
  readonly at: string;
}

interface Doubt {
  readonly skips: Occurrence[];
  readonly unclear: (Occurrence & {
    readonly probabilities: Readonly<Record<string, number>> | null;
  })[];
  /** The builder approved one of the key's skips with Run these now. */
  approvedOnce: boolean;
  /** A run that failed `blocked` lists one of the key's skips. */
  blocked: boolean;
}

/** The kind line of a key the store can't quote: a kind needs no key to say what it covers. */
const GENERIC_KIND = 'A kind of command with arguments like the examples';

/**
 * The kind line a candidate starts with, which the builder may reword: the key, and arguments like the examples.
 * It always passes `PrecedentKind`, so approving it never throws: a long key is cut, and one the kind can't hold
 * gives a line that names no key.
 */
export function defaultPrecedentKind(key: string): string {
  const shown = key.length > KEY_IN_KIND_MAX ? `${key.slice(0, KEY_IN_KIND_MAX)}…` : key;
  const parsed = PrecedentKind.safeParse(`\`${shown}\` with arguments like the examples`);
  return parsed.success ? parsed.data : GENERIC_KIND;
}

/** Whether the store can hold a precedent for this key, as `approvePrecedent` parses it. */
export function isStorableProgramKey(key: string): boolean {
  return ProgramKey.safeParse(key).success;
}

/** The text of what a call runs, as the card shows it: a recipe or a script's head, bounded. */
function runsText(runs: readonly RunText[]): string | null {
  const parts = runs.map((run) =>
    run.kind === 'make'
      ? `${run.makefile}: ${run.target}${run.prerequisites.length === 0 ? '' : ` (needs ${run.prerequisites.join(' ')})`}\n${run.recipe}`
      : `${run.path}\n${run.text}`,
  );
  const text = parts.join('\n\n').trim();
  if (text === '') return null;
  return text.length > RUNS_SHOWN_MAX ? `${text.slice(0, RUNS_SHOWN_MAX)}…` : text;
}

/**
 * What the newest example runs, as committed, and the hash a precedent compares later: both null where nothing is
 * read, the checkout differs from the base, or the reader isn't there. The call is read from the checkout's
 * root, as the hook judge reads a call that names no other folder.
 */
async function readRuns(
  key: string,
  call: string | null,
  checkout: string,
  read: CommittedReader | null,
): Promise<{ readonly runs: string | null; readonly hash: string | null }> {
  if (read === null || call === null) return { runs: null, hash: null };
  try {
    const found: CallRuns = await callRuns(call, checkout, checkout, read);
    if (found.differs) return { runs: null, hash: null };
    const file = keyPackageFile(key, checkout, checkout);
    const packageJson = file === null ? null : await read(file);
    const script = packageJson?.kind === 'same' ? packageScriptLine(packageJson.text, key) : null;
    return { runs: runsText(found.runs), hash: runsHash(found, script) };
  } catch {
    return { runs: null, hash: null };
  }
}

/** The likeliest limit of a reading and its probability; null when the reading answered none. */
function topWorryOf(
  probabilities: Readonly<Record<string, number>> | null,
): { limit: LimitName; p: number } | null {
  if (probabilities === null) return null;
  let top: { limit: LimitName; p: number } | null = null;
  for (const limit of LIMIT_ORDER) {
    const p = probabilities[limit];
    if (p !== undefined && (top === null || p > top.p)) top = { limit, p };
  }
  return top;
}

const newestFirst = (a: Occurrence, b: Occurrence): number => b.at.localeCompare(a.at);

/**
 * The kinds of command 10db's judge keeps doubting in the project's last `PRECEDENT_WINDOW_DAYS`: its own
 * skips with no limit named, and its calls that went to the second opinion, grouped by program key (`copy`
 * scope when every call of the key ran in a copy). A key is kept at `PRECEDENT_MIN_SKIPS` calls in
 * `PRECEDENT_MIN_RUNS` runs, when a run failed `blocked` with it among the skips, or when the builder approved
 * one of its skips with Run these now. A skip of Claude's auto mode never counts: only 10db's judge's rows are
 * read. It does not drop keys that have a precedent row; the card's write does, inside the write.
 */
export async function precedentCandidates(
  db: DbReader,
  projectId: ProjectId,
  now: Date,
  read: CommittedReader | null,
): Promise<PrecedentCandidateDto[]> {
  const since = new Date(now.getTime() - PRECEDENT_WINDOW_DAYS * DAY_MS).toISOString();
  const stoppedSince = new Date(now.getTime() - PRECEDENT_STOPPED_DAYS * DAY_MS).toISOString();
  const doubtSkips = listDoubtSkips(db, projectId, since).filter((s) => s.limitName === null);
  const approved = approvedSkipIds(
    db,
    doubtSkips.map((s) => s.id),
  );
  const failedBlocked = new Map<WorkstreamId, boolean>();
  const blockedRun = (id: WorkstreamId): boolean => {
    const known = failedBlocked.get(id);
    if (known !== undefined) return known;
    const blocked = getWorkstreamRow(db, id).failureKind === WorkstreamFailure.Blocked;
    failedBlocked.set(id, blocked);
    return blocked;
  };

  const byKey = new Map<string, Doubt>();
  const doubt = (key: string): Doubt => {
    const found = byKey.get(key);
    if (found !== undefined) return found;
    const fresh: Doubt = { skips: [], unclear: [], approvedOnce: false, blocked: false };
    byKey.set(key, fresh);
    return fresh;
  };
  for (const skip of doubtSkips) {
    const of = doubt(skip.programKey);
    of.skips.push({
      key: skip.programKey,
      call: skip.summary,
      workstreamId: skip.workstreamId,
      taskId: skip.taskId,
      inCopy: skip.inCopy,
      at: skip.createdAt,
    });
    if (approved.has(skip.id)) of.approvedOnce = true;
    if (blockedRun(skip.workstreamId)) of.blocked = true;
  }
  for (const call of listUnclearLimitCalls(db, projectId, since)) {
    doubt(call.programKey).unclear.push({
      key: call.programKey,
      call: call.command,
      workstreamId: call.workstreamId,
      taskId: call.taskId,
      inCopy: call.inCopy,
      at: call.createdAt,
      probabilities: call.probabilities,
    });
  }

  const stops = new Map<string, Set<string>>();
  for (const stop of listDoubtSkips(db, projectId, stoppedSince)) {
    if (stop.limitName === null) continue;
    const labels = stops.get(stop.programKey) ?? new Set<string>();
    labels.add(LIMITS[stop.limitName].label);
    stops.set(stop.programKey, labels);
  }

  const project = getProject(db, projectId);
  const candidates: PrecedentCandidateDto[] = [];
  for (const [key, found] of byKey) {
    // A key the store would refuse can't be approved, so it is never offered.
    if (!isStorableProgramKey(key)) continue;
    // A call that ended in a skip went to the second opinion first, so the likelier count of distinct doubtful
    // calls is the larger of the two lists, not their sum.
    const calls = Math.max(found.skips.length, found.unclear.length);
    const all = [...found.skips, ...found.unclear];
    const runIds = new Set(all.map((o) => o.workstreamId));
    const wanted =
      (calls >= PRECEDENT_MIN_SKIPS && runIds.size >= PRECEDENT_MIN_RUNS) ||
      found.blocked ||
      found.approvedOnce;
    if (!wanted) continue;
    const examples = [
      ...new Set(
        all
          .toSorted(newestFirst)
          .flatMap((o) => (o.call === null ? [] : [o.call]))
          .slice(0, EXAMPLES_SHOWN * 4),
      ),
    ].slice(0, EXAMPLES_SHOWN);
    const newest = all.toSorted(newestFirst)[0];
    const newestUnclear = found.unclear.toSorted(newestFirst)[0];
    const runs = await readRuns(key, newest?.call ?? null, project.repoPath, read);
    candidates.push({
      programKey: key,
      scope: all.every((o) => o.inCopy) ? PrecedentScope.Copy : PrecedentScope.Project,
      kind: defaultPrecedentKind(key),
      examples,
      runs: runs.runs,
      runsHash: runs.hash,
      skips: found.skips.length,
      runCount: runIds.size,
      taskCount: new Set(all.map((o) => o.taskId)).size,
      topWorry: topWorryOf(newestUnclear?.probabilities ?? null),
      stoppedAtLimit: [...(stops.get(key) ?? [])],
    });
  }
  return candidates
    .toSorted((a, b) => b.skips - a.skips || a.programKey.localeCompare(b.programKey))
    .slice(0, PRECEDENT_CANDIDATES_MAX);
}
