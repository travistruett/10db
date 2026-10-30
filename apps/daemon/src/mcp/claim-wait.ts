import {
  InvalidError,
  WorkstreamId,
  type ClaimKind,
  type InboxItemDto,
  type InboxItemId,
  type ProjectId,
} from '@10db/contracts';
import {
  acquireClaims,
  copyHazardNames,
  getProject,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  openItemsForWorkstream,
  type ClaimRow,
  type DbReader,
} from '@10db/db';
import { claimScopeOf } from '../delivery';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';

/** How often a task waiting for a claim looks again; the holder's release is not pushed to it. */
export const CLAIM_POLL_MS = 2_000;

export type ClaimResult =
  | { readonly granted: true; readonly claim: ClaimRow }
  | { readonly granted: false; readonly heldBy: WorkstreamId; readonly inboxId: InboxItemId };

interface Asking {
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

/** The workstream an open wait card of `workstreamId` says it waits for, if it has one. */
function waitsFor(db: DbReader, workstreamId: WorkstreamId): WorkstreamId | null {
  for (const item of openItemsForWorkstream(db, workstreamId)) {
    if (item.detail?.['waitingFor'] === undefined) continue;
    const heldBy = WorkstreamId.safeParse(item.detail['heldBy']);
    if (heldBy.success) return heldBy.data;
  }
  return null;
}

/** Whether `holder` waits, directly or through other waiters, for something `me` holds. */
function waitsOnMe(db: DbReader, holder: WorkstreamId, me: WorkstreamId): boolean {
  const seen = new Set<WorkstreamId>();
  let current: WorkstreamId | null = holder;
  while (current !== null && !seen.has(current)) {
    if (current === me) return true;
    seen.add(current);
    current = waitsFor(db, current);
  }
  return false;
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
 * itself waits, through any chain, for something this task holds, neither would ever move: the claim is
 * refused with a card saying so, and the agent decides.
 */
export async function claimOrWait(a: Asking): Promise<ClaimResult> {
  const db = a.state.db;
  let outcome = tryAcquire(a);
  if (outcome.ok) return grantedFrom(a, outcome.claims);
  let heldBy = outcome.conflict.heldBy;
  if (waitsOnMe(db, heldBy, a.workstreamId)) {
    const card = a.inbox.flag({
      projectId: a.projectId,
      workstreamId: a.workstreamId,
      title: `Claim deadlock: ${a.kind} ${a.name}`,
      body: `Task "${taskTitleOf(db, heldBy)}" holds ${a.kind} ${a.name} and is itself waiting for a claim that task "${taskTitleOf(db, a.workstreamId)}" holds, so neither can go on. Reason given: ${a.reason}`,
      detail: { heldBy },
    });
    return { granted: false, heldBy, inboxId: card.id };
  }
  const card: InboxItemDto = a.inbox.flag({
    projectId: a.projectId,
    workstreamId: a.workstreamId,
    title: `Waiting for ${a.kind} ${a.name}`,
    body: waitBody(a, heldBy),
    detail: waitDetail(a, heldBy),
    foldKey: `claim-wait:${a.workstreamId}:${a.kind}:${a.name}`,
  });
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
        a.inbox.reword(card.id, waitBody(a, heldBy), {
          options: card.options,
          detail: waitDetail(a, heldBy),
        });
      }
    }
  } finally {
    a.inbox.withdraw(card.id);
  }
  return grantedFrom(a, outcome.claims);
}

function grantedFrom(a: Asking, claims: readonly ClaimRow[]): ClaimResult {
  const claim = claims.find((c) => c.kind === a.kind && c.name === a.name);
  if (!claim) throw new InvalidError('Claim was granted but not found');
  return { granted: true, claim };
}
