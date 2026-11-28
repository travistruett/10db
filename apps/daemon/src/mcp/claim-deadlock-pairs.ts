import { ClaimKind, isTerminal, NotFoundError, WorkstreamId } from '@10db/contracts';
import {
  activeClaims,
  deleteAppSetting,
  getAppSetting,
  getWorkstreamRow,
  setAppSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';

/** The app setting that holds every pair of tasks a claim deadlock was broken between. */
export const CLAIM_DEADLOCKS_KEY = 'claim_deadlocks';
/** The app setting that holds the claims taken from a queued task, for its next brief. */
export const CLAIMS_TAKEN_KEY = 'claims_taken_while_queued';

const ClaimRef = z.object({ kind: z.enum(ClaimKind), name: z.string() });
type ClaimRef = z.infer<typeof ClaimRef>;

/** Two tasks a claim deadlock was broken between, stored with `a < b` so a pair has one record. */
export const DeadlockPair = z.object({
  a: WorkstreamId,
  b: WorkstreamId,
  breaks: z.number().int().nonnegative(),
  /** Every claim either side waited for at a break. */
  contested: z.array(ClaimRef),
  queued: z.object({ yielder: WorkstreamId, behind: WorkstreamId }).nullable(),
  /** A defect task was filed for this pair. */
  reported: z.boolean(),
});
export type DeadlockPair = z.infer<typeof DeadlockPair>;

/**
 * Claims taken from a queued task, kept apart from the pair so an Undo or the other task ending can't hide a
 * claim from the task that lost it.
 */
export const TakenClaims = z.object({
  from: WorkstreamId,
  to: WorkstreamId,
  claims: z.array(ClaimRef),
});
export type TakenClaims = z.infer<typeof TakenClaims>;

/** The key of every yield notice between the pair, posted on the yielder's task. */
export const deadlockNoticeKey = (a: WorkstreamId, b: WorkstreamId): string =>
  `claim-deadlock:${a}:${b}`;

/** Unset or unreadable reads as no pairs. */
function readPairs(db: DbReader): DeadlockPair[] {
  const parsed = z.array(DeadlockPair).safeParse(getAppSetting(db, CLAIM_DEADLOCKS_KEY));
  return parsed.success ? parsed.data : [];
}

function readTaken(db: DbReader): TakenClaims[] {
  const parsed = z.array(TakenClaims).safeParse(getAppSetting(db, CLAIMS_TAKEN_KEY));
  return parsed.success ? parsed.data : [];
}

function writePairs(w: WriteContext, pairs: readonly DeadlockPair[]): void {
  if (pairs.length === 0) {
    deleteAppSetting(w, CLAIM_DEADLOCKS_KEY);
    return;
  }
  setAppSetting(
    w,
    CLAIM_DEADLOCKS_KEY,
    pairs.map((pair) => ({
      ...pair,
      contested: pair.contested.map((claim) => ({ ...claim })),
      queued: pair.queued === null ? null : { ...pair.queued },
    })),
  );
}

function writeTaken(w: WriteContext, taken: readonly TakenClaims[]): void {
  if (taken.length === 0) {
    deleteAppSetting(w, CLAIMS_TAKEN_KEY);
    return;
  }
  setAppSetting(
    w,
    CLAIMS_TAKEN_KEY,
    taken.map((record) => ({ ...record, claims: record.claims.map((claim) => ({ ...claim })) })),
  );
}

function ordered(x: WorkstreamId, y: WorkstreamId): { a: WorkstreamId; b: WorkstreamId } {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

function isPair(pair: DeadlockPair, x: WorkstreamId, y: WorkstreamId): boolean {
  const { a, b } = ordered(x, y);
  return pair.a === a && pair.b === b;
}

function sameClaim(left: ClaimRef, right: ClaimRef): boolean {
  return left.kind === right.kind && left.name === right.name;
}

function union(left: readonly ClaimRef[], right: readonly ClaimRef[]): ClaimRef[] {
  const out: ClaimRef[] = [];
  for (const claim of [...left, ...right]) {
    if (!out.some((kept) => sameClaim(kept, claim)))
      out.push({ kind: claim.kind, name: claim.name });
  }
  return out;
}

/** A task whose row is gone, with its deleted project, has ended too. */
function ended(db: DbReader, id: WorkstreamId): boolean {
  try {
    return isTerminal(getWorkstreamRow(db, id).state);
  } catch (error) {
    if (error instanceof NotFoundError) return true;
    throw error;
  }
}

/** @public */
export function readPair(db: DbReader, x: WorkstreamId, y: WorkstreamId): DeadlockPair | null {
  return readPairs(db).find((pair) => isPair(pair, x, y)) ?? null;
}

/** @public */
export function recordBreak(
  w: WriteContext,
  input: {
    yielder: WorkstreamId;
    other: WorkstreamId;
    contested: readonly ClaimRef[];
    queue: boolean;
  },
): DeadlockPair {
  const pairs = readPairs(w.tx);
  const before = pairs.find((pair) => isPair(pair, input.yielder, input.other)) ?? {
    ...ordered(input.yielder, input.other),
    breaks: 0,
    contested: [],
    queued: null,
    reported: false,
  };
  const after: DeadlockPair = {
    ...before,
    breaks: before.breaks + 1,
    contested: union(before.contested, input.contested),
    queued: input.queue ? { yielder: input.yielder, behind: input.other } : before.queued,
  };
  writePairs(w, [...pairs.filter((pair) => !isPair(pair, input.yielder, input.other)), after]);
  return after;
}

/** @public */
export function markReported(w: WriteContext, x: WorkstreamId, y: WorkstreamId): void {
  const pairs = readPairs(w.tx);
  if (!pairs.some((pair) => isPair(pair, x, y))) return;
  writePairs(
    w,
    pairs.map((pair) => (isPair(pair, x, y) ? { ...pair, reported: true } : pair)),
  );
}

/**
 * False when the pair has no record. The claims taken from either task stay recorded: an Undo must not hide a
 * taken claim from the task that lost it.
 */
export function dropPair(w: WriteContext, x: WorkstreamId, y: WorkstreamId): boolean {
  const pairs = readPairs(w.tx);
  if (!pairs.some((pair) => isPair(pair, x, y))) return false;
  writePairs(
    w,
    pairs.filter((pair) => !isPair(pair, x, y)),
  );
  return true;
}

/**
 * The yielder's turn is over when the task it is queued behind has ended or holds none of the contested claims.
 * A task parked on a person has let its claims go, so it doesn't hold the yielder.
 */
export function turnOver(db: DbReader, pair: DeadlockPair): boolean {
  if (pair.queued === null) return true;
  const other = pair.queued.behind;
  if (ended(db, other)) return true;
  const held = activeClaims(db, other);
  return !pair.contested.some((claim) => held.some((row) => sameClaim(row, claim)));
}

/**
 * The task `id` is queued behind, or null. Ends the turn (nulls `queued`) only through `endTurn`.
 * @public
 */
export function queuedBehind(db: DbReader, id: WorkstreamId): WorkstreamId | null {
  const pair = readPairs(db).find((entry) => entry.queued?.yielder === id && !turnOver(db, entry));
  return pair?.queued?.behind ?? null;
}

/**
 * Every pair whose record queues `yielder`, whether or not its turn is over: the scheduler ends a turn that
 * is over (`endTurn`) before it launches the yielder.
 */
export function queuingPairs(db: DbReader, yielder: WorkstreamId): readonly DeadlockPair[] {
  return readPairs(db).filter((pair) => pair.queued?.yielder === yielder);
}

/** Adds `claim` to the pair's contested claims, counting no break. Nothing when the pair has no record. */
export function addContested(
  w: WriteContext,
  x: WorkstreamId,
  y: WorkstreamId,
  claim: ClaimRef,
): void {
  const pairs = readPairs(w.tx);
  if (!pairs.some((pair) => isPair(pair, x, y))) return;
  writePairs(
    w,
    pairs.map((pair) =>
      isPair(pair, x, y) ? { ...pair, contested: union(pair.contested, [claim]) } : pair,
    ),
  );
}

/** @public */
export function endTurn(w: WriteContext, pair: DeadlockPair): void {
  const pairs = readPairs(w.tx);
  if (!pairs.some((entry) => isPair(entry, pair.a, pair.b))) return;
  writePairs(
    w,
    pairs.map((entry) => (isPair(entry, pair.a, pair.b) ? { ...entry, queued: null } : entry)),
  );
}

/**
 * Drops the records of pairs with a terminal task, and the taken claims of a task that has ended.
 * @public
 */
export function forgetEndedPairs(w: WriteContext): void {
  const pairs = readPairs(w.tx);
  const livePairs = pairs.filter((pair) => !ended(w.tx, pair.a) && !ended(w.tx, pair.b));
  if (livePairs.length !== pairs.length) writePairs(w, livePairs);
  const taken = readTaken(w.tx);
  const liveTaken = taken.filter((record) => !ended(w.tx, record.from));
  if (liveTaken.length !== taken.length) writeTaken(w, liveTaken);
}

/** @public */
export function recordTaken(
  w: WriteContext,
  input: { from: WorkstreamId; to: WorkstreamId; claim: ClaimRef },
): void {
  const taken = readTaken(w.tx);
  const isRecord = (record: TakenClaims): boolean =>
    record.from === input.from && record.to === input.to;
  const before = taken.find(isRecord) ?? { from: input.from, to: input.to, claims: [] };
  const after: TakenClaims = { ...before, claims: union(before.claims, [input.claim]) };
  writeTaken(w, [...taken.filter((record) => !isRecord(record)), after]);
}

/**
 * What was taken from `id` that it does not hold again, for its next brief. Reads only.
 * @public
 */
export function takenFrom(db: DbReader, id: WorkstreamId): readonly TakenClaims[] {
  const held = activeClaims(db, id);
  return readTaken(db)
    .filter((record) => record.from === id)
    .map((record) => ({
      ...record,
      claims: record.claims.filter((claim) => !held.some((row) => sameClaim(row, claim))),
    }))
    .filter((record) => record.claims.length > 0);
}
