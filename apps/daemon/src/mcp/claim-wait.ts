import {
  InboxKind,
  InboxState,
  InvalidError,
  type ClaimKind,
  type InboxItemDto,
  type InboxItemId,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  acquireClaims,
  copyHazardNames,
  getProject,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  listInbox,
  type ClaimRow,
  type DbReader,
} from '@10db/db';
import { claimScopeOf } from '../delivery';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';

/** How often a task waiting for a claim looks again; the holder's release is not pushed to it. */
export const CLAIM_POLL_MS = 2_000;

/**
 * How long one request_claim call waits before it answers "still waiting". The session's tool timeout
 * is `humanWaitMinutes + 5` minutes and humanWaitMinutes is at least 1, so four minutes always answers
 * before Claude Code gives up on the call.
 */
export const CLAIM_WAIT_SLICE_MS = 4 * 60_000;

export type ClaimResult =
  | { readonly granted: true; readonly claim: ClaimRow }
  | { readonly granted: false; readonly heldBy: WorkstreamId; readonly inboxId: InboxItemId };

export interface Asking {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly projectId: ProjectId;
  readonly workstreamId: WorkstreamId;
  readonly kind: ClaimKind;
  readonly name: string;
  readonly reason: string;
  /** Aborts when the session stops, which ends the wait. */
  readonly signal: AbortSignal;
  readonly pollMs: number;
}

/** Where a wait in progress stands: who holds the claim now, and its card. */
export interface WaitState {
  readonly workstreamId: WorkstreamId;
  heldBy: WorkstreamId | null;
  inboxId: InboxItemId | null;
}

/** A wait in progress and how it ends. */
export interface LiveWait {
  readonly state: WaitState;
  readonly done: Promise<ClaimResult>;
}

const WAIT_CARD = 'claim-wait';

/**
 * The claim waits in progress in this daemon. They live in memory, not in the cards, because a wait
 * ends with the process and the builder can dismiss a card: neither may change what the deadlock check
 * sees. One claim of one workstream has at most one wait, which every call for it joins.
 */
export class ClaimWaits {
  readonly #live = new Map<string, LiveWait>();

  /** Joins the wait for this claim, or starts one; the returned wait's `done` never rejects unhandled. */
  join(a: Asking): LiveWait {
    const key = `${a.workstreamId}:${a.kind}:${a.name}`;
    const existing = this.#live.get(key);
    if (existing) return existing;
    const state: WaitState = { workstreamId: a.workstreamId, heldBy: null, inboxId: null };
    const done = claimOrWait(a, state, this).finally(() => {
      this.#live.delete(key);
    });
    done.catch(() => undefined);
    const entry = { state, done };
    this.#live.set(key, entry);
    return entry;
  }

  /** The workstreams `workstreamId` is waiting on now. */
  holdersAwaitedBy(workstreamId: WorkstreamId): WorkstreamId[] {
    const out: WorkstreamId[] = [];
    for (const { state } of this.#live.values())
      if (state.workstreamId === workstreamId && state.heldBy !== null) out.push(state.heldBy);
    return out;
  }

  /** Whether `holder` waits, directly or through other waiters, for something `me` holds. */
  waitsOn(holder: WorkstreamId, me: WorkstreamId): boolean {
    const seen = new Set<WorkstreamId>();
    const todo = [holder];
    for (let current = todo.pop(); current !== undefined; current = todo.pop()) {
      if (current === me) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      todo.push(...this.holdersAwaitedBy(current));
    }
    return false;
  }
}

/**
 * Closes the wait cards a stopped daemon left open. Their waits ended with it, and a card that outlived
 * its wait would name a holder nobody waits for.
 */
export function withdrawStaleClaimWaits(state: StateStore, inbox: InboxService): void {
  for (const item of listInbox(state.db, { states: [InboxState.Open] }))
    if (item.kind === InboxKind.Flag && item.detail?.['waitingFor'] !== undefined)
      inbox.withdraw(item.id);
}

const taskTitleOf = (db: DbReader, workstreamId: WorkstreamId): string =>
  getTask(db, getWorkstream(db, workstreamId).taskId).title;

/** One try, in one write: the claim shares the workstream's lease, which the scheduler's heartbeat renews. */
function tryAcquire(a: Asking) {
  return a.state.write((ctx) => {
    const row = getWorkstreamRow(ctx.tx, a.workstreamId);
    const areaScope = claimScopeOf(ctx.tx, row);
    return acquireClaims(ctx, {
      projectId: a.projectId,
      workstreamId: a.workstreamId,
      requests: [{ kind: a.kind, name: a.name }],
      leaseExpiresAt: row.leaseExpiresAt ?? ctx.now,
      copyHazards: copyHazardNames(getProject(ctx.tx, a.projectId)),
      ...(areaScope ? { areaScope } : {}),
    });
  });
}

function waitDetail(a: Asking, heldBy: WorkstreamId) {
  return { waitingFor: { kind: a.kind, name: a.name }, heldBy };
}

function waitBody(a: Asking, heldBy: WorkstreamId): string {
  const db = a.state.db;
  return [
    `Task "${taskTitleOf(db, heldBy)}" holds ${a.kind} ${a.name}.`,
    `Task "${taskTitleOf(db, a.workstreamId)}" is waiting for it and continues when it frees.`,
    `Reason given: ${a.reason}`,
  ].join(' ');
}

function deadlock(a: Asking, heldBy: WorkstreamId): ClaimResult {
  const db = a.state.db;
  const card = a.inbox.flag({
    projectId: a.projectId,
    workstreamId: a.workstreamId,
    title: `Claim deadlock: ${a.kind} ${a.name}`,
    body: `Task "${taskTitleOf(db, heldBy)}" holds ${a.kind} ${a.name} and is itself waiting for a claim that task "${taskTitleOf(db, a.workstreamId)}" holds, so neither can go on. Reason given: ${a.reason}`,
    detail: { heldBy },
  });
  return { granted: false, heldBy, inboxId: card.id };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Takes the claim, or waits for the holder to free it and takes it then. The wait has a card that names
 * the holder's task and says this task is waiting; it is withdrawn when the wait ends. When the holder
 * itself waits, through any chain, for something this task holds (checked again whenever the holder
 * changes), neither would ever move: the claim is refused with a card saying so, and the agent decides.
 * Runs synchronously up to its first wait, so `wait` names the holder and card by the time
 * `ClaimWaits.join` returns.
 */
async function claimOrWait(a: Asking, wait: WaitState, waits: ClaimWaits): Promise<ClaimResult> {
  let outcome = tryAcquire(a);
  if (outcome.ok) return grantedFrom(a, outcome.claims);
  let heldBy = outcome.conflict.heldBy;
  if (waits.waitsOn(heldBy, a.workstreamId)) return deadlock(a, heldBy);
  // A card a stopped daemon left with this fold key is rewritten to say who holds the claim now.
  const card: InboxItemDto = a.inbox.flag({
    projectId: a.projectId,
    workstreamId: a.workstreamId,
    title: `Waiting for ${a.kind} ${a.name}`,
    body: waitBody(a, heldBy),
    detail: waitDetail(a, heldBy),
    foldKey: `${WAIT_CARD}:${a.workstreamId}:${a.kind}:${a.name}`,
    refresh: true,
  });
  wait.heldBy = heldBy;
  wait.inboxId = card.id;
  try {
    while (!outcome.ok) {
      await sleep(a.pollMs, a.signal);
      if (a.signal.aborted)
        throw new InvalidError(
          'This session stopped waiting for the claim and did not get it. End your turn.',
        );
      outcome = tryAcquire(a);
      if (!outcome.ok && outcome.conflict.heldBy !== heldBy) {
        heldBy = outcome.conflict.heldBy;
        wait.heldBy = heldBy;
        if (waits.waitsOn(heldBy, a.workstreamId)) return deadlock(a, heldBy);
        a.inbox.reword(card.id, waitBody(a, heldBy), {
          options: card.options,
          detail: waitDetail(a, heldBy),
        });
      }
    }
  } finally {
    wait.heldBy = null;
    a.inbox.withdraw(card.id);
  }
  return grantedFrom(a, outcome.claims);
}

function grantedFrom(a: Asking, claims: readonly ClaimRow[]): ClaimResult {
  const claim = claims.find((c) => c.kind === a.kind && c.name === a.name);
  if (!claim) throw new InvalidError('Claim was granted but not found');
  return { granted: true, claim };
}
