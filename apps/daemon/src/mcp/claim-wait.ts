import {
  BuilderOwns,
  CardDecider,
  DecisionRule,
  EventType,
  InboxKind,
  InboxState,
  InvalidError,
  isTerminal,
  SharedAskDetail,
  WorkstreamId,
  WorkstreamState,
  type ClaimKind,
  type InboxItemDto,
  type InboxItemId,
  type Notice,
  type ProjectId,
  Urgency,
} from '@10db/contracts';
import {
  acquireClaims,
  activeClaims,
  claimHolder,
  clearWorkstreamNotices,
  copyHazardNames,
  findOpenByFoldKey,
  getProject,
  getTask,
  getWorkstream,
  getHold,
  getInboxItem,
  getWorkstreamRow,
  isRuleAsking,
  listInbox,
  listSignOffWaits,
  releaseClaim,
  setWorkstreamNotice,
  type AcquireResult,
  type ClaimRow,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { claimScopeOf } from '../delivery';
import type { EventBus, StateStore } from '../events';
import type { InboxService } from '../inbox';
import { DEADLOCK_DETAIL, deadlockAnswers, taskLetter } from './claim-deadlock';
import {
  addContested,
  deadlockNoticeKey,
  readPair,
  recordBreak,
  recordTaken,
  type DeadlockPair,
} from './claim-deadlock-pairs';
import { DeadlockMove, deadlockMove } from './claim-deadlock-rule';
import { CardTier, decidedByBuilder, postNotice } from '../inbox';

/** How often a task waiting for a claim looks again; the holder's release is not pushed to it. */
export const CLAIM_POLL_MS = 2_000;

/**
 * How long one request_claim call waits before it answers "still waiting". The session's tool timeout
 * is `humanWaitMinutes + 5` minutes and humanWaitMinutes is at least 1, so four minutes always answers
 * before Claude Code gives up on the call.
 */
export const CLAIM_WAIT_SLICE_MS = 4 * 60_000;

export type ClaimResult =
  | {
      readonly granted: true;
      readonly claim: ClaimRow;
      /**
       * The edits the task that held the claim before this wait took it left uncommitted in the
       * checkout they share (`Asking.handOver`); null when no task held it while this wait waited.
       */
      readonly handed: { readonly from: WorkstreamId; readonly paths: readonly string[] } | null;
    }
  | {
      readonly granted: false;
      readonly heldBy: WorkstreamId | null;
      readonly inboxId: InboxItemId | null;
      /** What the refused agent does next. */
      readonly instruction: string;
      /**
       * The refusal tells the agent about claims the builder or 10db made its task yield
       * (`ClaimWaits.yielded`).
       */
      readonly yielded: boolean;
      /** The yield also queued the task behind the other one, so it hands off. */
      readonly queued: boolean;
      /** The holder is parked for the update: true only now, so the answer is not kept under the opId. */
      readonly parked: boolean;
    };

/**
 * How a pass lane's shared area is granted (Workbench spec §7.2): after the builder's answer when one
 * is asked, and then, once the claim is free, by a grant that records the hold with the claim.
 */
export interface SharedGrant {
  /**
   * Raises the builder's question when the area needs one, or answers null. Its answer is null to go
   * on to the claim, else the refusal the call answers; it rejects when the session stops waiting.
   */
  ask(): { readonly inboxId: InboxItemId; readonly answer: Promise<ClaimResult | null> } | null;
  /**
   * Grants the free claim with its hold in one write; a task that took it first is the conflict, and
   * null means the lane's turn has ended, so nothing was granted.
   */
  grant(): Promise<AcquireResult | null>;
  /**
   * Whether the turn the wait began in is still open: an area is held only for a turn, so a wait
   * ends with that turn, even when the next has opened.
   */
  turnOpen(): boolean;
}

/** What a shared wait answers once the lane's turn has ended without the area. */
function turnEndedRefusal(a: Asking, inboxId: InboxItemId | null): ClaimResult {
  return {
    granted: false,
    heldBy: null,
    inboxId,
    yielded: false,
    queued: false,
    parked: false,
    instruction: `Your turn ended before shared ${a.kind} ${a.name} was granted, so you did not get it. If you still need it in a later turn, call request_claim with a new opId then.`,
  };
}

/**
 * The builder's answer to a shared question, or the turn's end: looked at every `pollMs`, so a
 * question the turn's end withdrew ends the wait. Rejects when the session stops waiting.
 */
async function answerOrTurnEnd(
  a: Asking & { readonly shared: SharedGrant },
  asked: { readonly inboxId: InboxItemId; readonly answer: Promise<ClaimResult | null> },
): Promise<ClaimResult | null> {
  const answered = asked.answer.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  for (;;) {
    const next = await Promise.race([answered, sleep(a.pollMs, a.signal).then(() => null)]);
    if (next !== null) {
      if ('error' in next) throw next.error;
      return next.result;
    }
    if (a.signal.aborted) throw new InvalidError('aborted');
    if (!a.shared.turnOpen()) {
      if (cardOpen(a, asked.inboxId)) a.inbox.withdraw(asked.inboxId);
      return turnEndedRefusal(a, asked.inboxId);
    }
    // A question closed with no answer (withdrawn, or cancelled with the run) is never answered.
    if (!cardOpen(a, asked.inboxId)) {
      if (getInboxItem(a.state.db, asked.inboxId).answer === null)
        return withdrawnRefusal(a, asked.inboxId);
      const given = await answered;
      if ('error' in given) throw given.error;
      return given.result;
    }
  }
}

/** What a shared wait answers when its question closed with no answer. */
function withdrawnRefusal(a: Asking, inboxId: InboxItemId): ClaimResult {
  return {
    granted: false,
    heldBy: null,
    inboxId,
    yielded: false,
    queued: false,
    parked: false,
    instruction: `The builder's question about shared ${a.kind} ${a.name} was closed without an answer, so you did not get it. If you still need it, call request_claim with a new opId.`,
  };
}

/** Claims the builder or 10db made a task give up to end a claim deadlock, until its agent is told. */
export interface Yielded {
  readonly claims: readonly { readonly kind: ClaimKind; readonly name: string }[];
  /** The builder's deadlock card the yield answered; null when 10db's rule made the task yield. */
  readonly inboxId: InboxItemId | null;
  /** The task the rule's yield handed the claims to; null for the builder's answer. */
  readonly to: WorkstreamId | null;
  /** The yield also queued the task behind `to`. */
  readonly queued: boolean;
}

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
  /** The clock a claim deadlock's age is read from, in milliseconds. */
  now(): number;
  /** A pass lane's shared area: asked about first, then granted with its hold. */
  readonly shared?: SharedGrant;
  /**
   * Records, as `from`'s, the uncommitted edits `from` left under the claim in the checkout it shares
   * with this task, once this wait takes the claim `from` held, and answers their paths.
   */
  handOver(from: WorkstreamId): Promise<readonly string[]>;
  /**
   * A third deadlock between the same pair is reported, in the write that yields and queues; `thisBreak` is
   * the line of that write's notice. Answers the report when the notice's body must carry it, else null.
   */
  reportRepeat(w: WriteContext, pair: DeadlockPair, thisBreak: string): string | null;
}

/** Where a wait in progress stands: who holds the claim now. */
export interface WaitState {
  readonly workstreamId: WorkstreamId;
  readonly kind: ClaimKind;
  readonly name: string;
  heldBy: WorkstreamId | null;
  /** The open deadlock card this wait waits on for the builder's answer, if any. */
  inboxId: InboxItemId | null;
  /** The open question about a shared area this wait waits on before it asks for the claim, if any. */
  askId: InboxItemId | null;
}

/** A wait in progress and how it ends. */
export interface LiveWait {
  readonly state: WaitState;
  readonly done: Promise<ClaimResult>;
  /** A shared wait whose turn has ended takes no new call: it is ending, with nothing. */
  readonly stale: () => boolean;
}

const DEADLOCK_CARD = 'claim-deadlock';

/**
 * The claim waits in progress in this daemon. They live in memory, not in the cards, because a wait
 * ends with the process and the builder can dismiss a card: neither may change what the deadlock check
 * sees. One claim of one workstream has at most one wait, which every call for it joins.
 */
export class ClaimWaits {
  readonly #live = new Map<string, LiveWait>();
  readonly #yields = new Map<WorkstreamId, Yielded>();
  readonly #cancelled = new Set<WorkstreamId>();
  readonly #onWait: () => void;
  readonly #parked: (holder: WorkstreamId) => boolean;

  /**
   * `onWait` runs when a wait starts waiting on a holder; the daemon asks the scheduler to look again.
   * `parked` says whether a holder is held back by the update drain (see `holderParked`).
   */
  constructor(
    opts: {
      readonly onWait?: () => void;
      readonly parked?: (holder: WorkstreamId) => boolean;
    } = {},
  ) {
    this.#onWait = opts.onWait ?? (() => undefined);
    this.#parked = opts.parked ?? (() => false);
  }

  /**
   * Whether `holder` starts nothing until the update installs, so it frees no claim in time: a wait on
   * it would keep its own session running, and the update waits for that session to end.
   */
  holderParked(holder: WorkstreamId): boolean {
    return this.#parked(holder);
  }

  /** Joins the wait for this claim, or starts one; the returned wait's `done` never rejects unhandled. */
  join(a: Asking): LiveWait {
    const key = `${a.workstreamId}:${a.kind}:${a.name}`;
    const existing = this.#live.get(key);
    if (existing && !existing.stale()) return existing;
    const state: WaitState = {
      workstreamId: a.workstreamId,
      kind: a.kind,
      name: a.name,
      heldBy: null,
      inboxId: null,
      askId: null,
    };
    const shared = a.shared;
    const stale = (): boolean => shared !== undefined && !shared.turnOpen();
    const done = claimOrWait(a, state, this).finally(() => {
      // A wait that took a stale one's place is not this one's to remove.
      if (this.#live.get(key) === entry) this.#live.delete(key);
      if (![...this.#live.values()].some((w) => w.state.workstreamId === a.workstreamId))
        this.#cancelled.delete(a.workstreamId);
    });
    done.catch(() => undefined);
    const entry: LiveWait = { state, done, stale };
    this.#live.set(key, entry);
    return entry;
  }

  /**
   * The builder or 10db's rule made `workstreamId` give up `claims` to end a deadlock. Its waits end with a refusal
   * naming them, and until a request_claim call has passed that on, every new ask by the task answers it
   * at once: the agent learns it lost them before it edits there again. False, and nothing kept, when the
   * task has no wait in progress: it is not in a deadlock, so nothing is to be given up.
   */
  yielded(workstreamId: WorkstreamId, given: Yielded): boolean {
    if (![...this.#live.values()].some((w) => w.state.workstreamId === workstreamId)) return false;
    const before = this.#yields.get(workstreamId)?.claims ?? [];
    this.#yields.set(workstreamId, { ...given, claims: [...before, ...given.claims] });
    return true;
  }

  /**
   * The builder cancelled `workstreamId`. Its waits end at their next look and count as waiting for
   * nothing from now on: its session takes a moment to stop, and until then its wait must not raise the
   * deadlock card again for a deadlock the cancel just ended.
   */
  cancelled(workstreamId: WorkstreamId): void {
    if ([...this.#live.values()].some((w) => w.state.workstreamId === workstreamId))
      this.#cancelled.add(workstreamId);
  }

  /** Whether the builder cancelled this task while it waited. */
  isCancelled(workstreamId: WorkstreamId): boolean {
    return this.#cancelled.has(workstreamId);
  }

  /** Claims the task was made to give up that its agent has not been told of yet. */
  pendingYield(workstreamId: WorkstreamId): Yielded | undefined {
    return this.#yields.get(workstreamId);
  }

  /** A request_claim call returned the refusal naming them: the agent knows. */
  yieldDelivered(workstreamId: WorkstreamId): void {
    this.#yields.delete(workstreamId);
  }

  /**
   * The task reached a terminal state. A yield its agent never heard about dies with it: nobody will ask
   * again, and a later session of the workstream (a retry) would otherwise get its first claim answer
   * from an old refusal.
   */
  ended(workstreamId: WorkstreamId): void {
    this.#yields.delete(workstreamId);
  }

  /**
   * Whether a wait in progress waits on this deadlock card. One that none waits on describes a deadlock
   * that has ended (or a daemon that stopped), so an answer to it would act on nothing.
   */
  awaitsCard(inboxId: InboxItemId): boolean {
    return [...this.#live.values()].some((w) => w.state.inboxId === inboxId);
  }

  /** A wait started waiting on a holder, or on a new one. */
  waitingOn(): void {
    this.#onWait();
  }

  /**
   * Every workstream some wait is waiting on now. The scheduler launches such a holder over the lane
   * caps: its waiters keep their lanes, and could otherwise fill every lane it needs to finish and free
   * the claim.
   */
  awaitedHolders(): ReadonlySet<WorkstreamId> {
    const out = new Set<WorkstreamId>();
    for (const { state } of this.#live.values()) if (state.heldBy !== null) out.add(state.heldBy);
    return out;
  }

  /**
   * The workstreams `workstreamId` is waiting on now. A task `ended` (finished, failed or cancelled)
   * waits for nothing, whatever its session still shows.
   */
  holdersAwaitedBy(
    workstreamId: WorkstreamId,
    ended: (id: WorkstreamId) => boolean = () => false,
  ): WorkstreamId[] {
    const out: WorkstreamId[] = [];
    if (this.#cancelled.has(workstreamId) || ended(workstreamId)) return out;
    for (const { state } of this.#live.values())
      if (state.workstreamId === workstreamId && state.heldBy !== null) out.push(state.heldBy);
    return out;
  }

  /**
   * The claims `holder` holds that a wait is waiting for, among the waits of `start` and of everything
   * `start` waits on through other waiters: what `holder` gives up to unblock `start`. Each claim is
   * listed once, however many of those waiters wait for it.
   */
  claimsAwaitedFrom(
    holder: WorkstreamId,
    start: WorkstreamId,
  ): { readonly kind: ClaimKind; readonly name: string }[] {
    const out = new Map<string, { readonly kind: ClaimKind; readonly name: string }>();
    for (const { state } of this.#live.values())
      if (
        state.heldBy === holder &&
        (state.workstreamId === start || this.waitsOn(start, state.workstreamId))
      )
        out.set(`${state.kind}:${state.name}`, { kind: state.kind, name: state.name });
    return [...out.values()];
  }

  /**
   * Whether `holder` waits, directly or through other waiters, for something `me` holds. Tasks `ended`
   * wait for nothing, so a chain through one is no deadlock.
   */
  waitsOn(
    holder: WorkstreamId,
    me: WorkstreamId,
    ended: (id: WorkstreamId) => boolean = () => false,
  ): boolean {
    const seen = new Set<WorkstreamId>();
    const todo = [holder];
    for (let current = todo.pop(); current !== undefined; current = todo.pop()) {
      if (current === me) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      todo.push(...this.holdersAwaitedBy(current, ended));
    }
    return false;
  }
}

/**
 * Drops a task's pending yield (`ClaimWaits.ended`) when the task reaches a terminal state. Returns the
 * function that ends the subscription.
 */
export function forgetEndedYields(bus: EventBus, waits: ClaimWaits): () => void {
  return bus.subscribe((event) => {
    if (event.type !== EventType.WorkstreamChanged) return;
    const to = Object.values(WorkstreamState).find((s) => s === event.data['to']);
    const id = WorkstreamId.safeParse(event.entityId);
    if (to !== undefined && id.success && isTerminal(to)) waits.ended(id.data);
  });
}

/**
 * Clears the waits a stopped daemon left showing on its tasks. Their waits ended with it, and a notice
 * that outlived its wait would name a holder nobody waits for. Also closes the wait cards an earlier
 * build raised, which a task's card shows instead now, and each pass's shared-area question, whose
 * asking call ended with the daemon: the agent asks again.
 */
export function withdrawStaleClaimWaits(state: StateStore, inbox: InboxService): void {
  state.write((ctx) => clearWorkstreamNotices(ctx));
  for (const item of listInbox(state.db, { states: [InboxState.Open] }))
    if (
      (item.kind === InboxKind.Flag && (isWaitCard(item) || isDeadlockCard(item))) ||
      (item.kind === InboxKind.Question && SharedAskDetail.safeParse(item.detail).success)
    )
      inbox.withdraw(item.id);
}

const isWaitCard = (item: InboxItemDto): boolean => item.detail?.['waitingFor'] !== undefined;

/**
 * A deadlock card belongs to a wait, and every wait ended with the daemon: an answer to it would free
 * nothing, or cancel a task for a deadlock that is gone. An earlier build's card carries only `heldBy`.
 */
const isDeadlockCard = (item: InboxItemDto): boolean =>
  item.detail?.[DEADLOCK_DETAIL] !== undefined ||
  (item.detail?.['heldBy'] !== undefined && item.title.startsWith('Claim deadlock:'));

const taskTitleOf = (db: DbReader, workstreamId: WorkstreamId): string =>
  getTask(db, getWorkstream(db, workstreamId).taskId).title;

/**
 * A shared grant's look, in one read: the conflict with a task holding the claim, the claim itself
 * when this task holds it already, or null while it is free and the grant decides.
 */
function heldNow(a: Asking): AcquireResult | null {
  const db = a.state.db;
  const areaScope = claimScopeOf(db, getWorkstreamRow(db, a.workstreamId));
  const holder = claimHolder(db, {
    projectId: a.projectId,
    request: { kind: a.kind, name: a.name },
    copyHazards: copyHazardNames(getProject(db, a.projectId)),
    ...(areaScope ? { areaScope } : {}),
  });
  if (holder === null) return null;
  if (holder === a.workstreamId) return tryAcquire(a).outcome;
  return { ok: false, conflict: { kind: a.kind, name: a.name, heldBy: holder } };
}

/**
 * One try, in one write: the claim shares the workstream's lease, which the scheduler's heartbeat renews.
 * A claim held by a task queued behind this one is taken in the same write, but only while that task can't
 * run: its pair's record queues it behind this task, its row is `Queued` and it holds no lease. The take
 * adds the claim to the pair's contested claims and records it for the queued task's next brief
 * (`recordTaken`); `takenFrom` names the task it was taken from.
 */
function tryAcquire(a: Asking): {
  readonly outcome: AcquireResult;
  readonly takenFrom: WorkstreamId | null;
} {
  return a.state.write((ctx) => {
    const me = a.workstreamId;
    const row = getWorkstreamRow(ctx.tx, me);
    const areaScope = claimScopeOf(ctx.tx, row);
    const ask = {
      projectId: a.projectId,
      workstreamId: me,
      requests: [{ kind: a.kind, name: a.name }],
      leaseExpiresAt: row.leaseExpiresAt ?? ctx.now,
      copyHazards: copyHazardNames(getProject(ctx.tx, a.projectId)),
      ...(areaScope ? { areaScope } : {}),
    };
    const outcome = acquireClaims(ctx, ask);
    if (outcome.ok) return { outcome, takenFrom: null };
    const holder = outcome.conflict.heldBy;
    const queued = readPair(ctx.tx, me, holder)?.queued;
    const holderRow = getWorkstreamRow(ctx.tx, holder);
    if (
      queued?.yielder !== holder ||
      queued.behind !== me ||
      holderRow.state !== WorkstreamState.Queued ||
      holderRow.leaseOwner !== null
    )
      return { outcome, takenFrom: null };
    const held = activeClaims(ctx.tx, holder).find(
      (claim) => claim.kind === a.kind && claim.name === a.name,
    );
    if (held === undefined) return { outcome, takenFrom: null };
    releaseClaim(ctx, held.id);
    const claim = { kind: a.kind, name: a.name };
    addContested(ctx, me, holder, claim);
    recordTaken(ctx, { from: holder, to: me, claim });
    return { outcome: acquireClaims(ctx, ask), takenFrom: holder };
  });
}

function waitBody(a: Asking, heldBy: WorkstreamId): string {
  const db = a.state.db;
  return [
    `Task "${taskTitleOf(db, heldBy)}" holds ${a.kind} ${a.name}.`,
    `Task "${taskTitleOf(db, a.workstreamId)}" is waiting for it and continues when it frees.`,
    `Reason given: ${a.reason}`,
  ].join(' ');
}

/**
 * What the waiting task's card and drawer say, naming the task that holds the claim. No Inbox card: the
 * builder is asked nothing, and the wait ends by itself when the holder lets go.
 */
const waitNoticeKey = (a: Asking): string => `claim-wait:${a.kind}:${a.name}`;

function waitNotice(a: Asking, heldBy: WorkstreamId): Notice {
  return {
    key: waitNoticeKey(a),
    tone: 'info',
    line: `Waiting for ${a.kind} ${a.name}: task "${taskTitleOf(a.state.db, heldBy)}" holds it`,
    body: waitBody(a, heldBy),
  };
}

/**
 * What the later asker's card and drawer say while its deadlock is younger than the yield: no Inbox card, since
 * 10db ends it by itself.
 */
function deadlockWaitNotice(a: Asking, heldBy: WorkstreamId): Notice {
  const db = a.state.db;
  const holder = taskTitleOf(db, heldBy);
  return {
    key: waitNoticeKey(a),
    tone: 'info',
    line: `Waits for ${a.kind} ${a.name}; task "${holder}" waits for a claim this one holds`,
    body: [
      `Task "${holder}" holds ${a.kind} ${a.name} and is itself waiting for a claim task "${taskTitleOf(db, a.workstreamId)}" holds, so neither can go on.`,
      'If it still stands after 2 minutes, this task gives up what the other waits for; its uncommitted edits stay its own.',
      `Reason given: ${a.reason}`,
    ].join(' '),
  };
}

/**
 * The later asker gives up what `holder` waits for, in one write that releases it, records the break between
 * the pair and posts the undoable notice; then its waits are told. False, with nothing written, when it holds
 * none of it any more: the waits changed, and a yield that frees nothing breaks nothing.
 */
function breakDeadlock(
  a: Asking,
  holder: WorkstreamId,
  gives: readonly { readonly kind: ClaimKind; readonly name: string }[],
  waits: ClaimWaits,
  move: DeadlockMove,
): boolean {
  const me = a.workstreamId;
  const queue = move !== DeadlockMove.Yield;
  const released = a.state.write((ctx) => {
    const rows = activeClaims(ctx.tx, me).filter((row) =>
      gives.some((c) => c.kind === row.kind && c.name === row.name),
    );
    if (rows.length === 0) return [];
    for (const row of rows) releaseClaim(ctx, row.id);
    const claims = rows.map((row) => ({ kind: row.kind, name: row.name }));
    const pair = recordBreak(ctx, {
      yielder: me,
      other: holder,
      contested: [...claims, { kind: a.kind, name: a.name }],
      queue,
    });
    const yielder = taskTitleOf(ctx.tx, me);
    const other = taskTitleOf(ctx.tx, holder);
    const list = claims.map((c) => `${c.kind} ${c.name}`).join(', ');
    const line = `"${yielder}" gave up ${list} to "${other}" to end a claim deadlock`;
    const report =
      move === DeadlockMove.YieldQueueAndReport ? a.reportRepeat(ctx, pair, line) : null;
    postNotice(ctx, {
      tier: CardTier.Notice,
      projectId: a.projectId,
      taskId: getWorkstreamRow(ctx.tx, me).taskId,
      key: deadlockNoticeKey(pair.a, pair.b),
      tone: 'info',
      line,
      body: [
        `Task "${yielder}" waited for ${a.kind} ${a.name}, which task "${other}" holds, while "${other}" waited for ${list}, which "${yielder}" held.`,
        `After 2 minutes "${yielder}", the later to ask, gave up ${list}. "${other}" got its committed work only: the uncommitted edits there stay "${yielder}"'s own.`,
        queue
          ? `Undo ends the queue: "${yielder}" may start and ask again now.`
          : 'Undo forgets this yield: the two tasks count as never having deadlocked.',
        ...(report === null ? [] : [report]),
      ].join('\n\n'),
      decision: {
        by: CardDecider.Rule,
        rule: DecisionRule.ClaimDeadlock,
        confidence: null,
        undo: {
          state: 'undoable',
          action: { kind: 'forget_claim_deadlock', a: pair.a, b: pair.b },
        },
      },
    });
    return claims;
  });
  if (released.length === 0) return false;
  waits.yielded(me, { claims: released, inboxId: null, to: holder, queued: queue });
  return true;
}

const deadlockKey = (a: Asking): string => `${DEADLOCK_CARD}:${a.workstreamId}:${a.kind}:${a.name}`;

/**
 * Raises the card for a claim deadlock and returns its id. One card per claim: a deadlock found again
 * rewrites it, so the agent's retries raise no second card. The builder answers which task yields its
 * claim, or which is cancelled, and the daemon acts on it (`createClaimDeadlockAnswers`).
 */
function deadlock(a: Asking, heldBy: WorkstreamId, waits: ClaimWaits): InboxItemId {
  const db = a.state.db;
  const asker = taskTitleOf(db, a.workstreamId);
  const holder = taskTitleOf(db, heldBy);
  const { options, detail } = deadlockAnswers([
    {
      workstreamId: a.workstreamId,
      title: asker,
      yields: waits.claimsAwaitedFrom(a.workstreamId, heldBy),
    },
    { workstreamId: heldBy, title: holder, yields: [{ kind: a.kind, name: a.name }] },
  ]);
  const body = [
    `Task ${taskLetter(0)} is "${asker}" and task ${taskLetter(1)} is "${holder}". ${taskLetter(1)} holds ${a.kind} ${a.name} and is itself waiting for a claim that ${taskLetter(0)} holds, so neither can go on. Reason given: ${a.reason}`,
    ...options.map((o) => `- ${o.label}: ${o.description}`),
  ].join('\n');
  const card = a.inbox.flag({
    projectId: a.projectId,
    workstreamId: a.workstreamId,
    tier: CardTier.Ask,
    urgency: Urgency.High,
    closesWhen: { by: 'withdrawn', when: 'the deadlock clears (claim-wait)' },
    decision: decidedByBuilder(BuilderOwns.OutOfMoves),
    title: `Claim deadlock: ${a.kind} ${a.name}`,
    body,
    options,
    detail: { heldBy, ...detail },
    foldKey: deadlockKey(a),
    refresh: true,
    // Only the rule's ask move raises this card; otherwise the later asker yields.
    sentUp: DecisionRule.ClaimDeadlock,
  });
  return card.id;
}

/** What a call answers when its slice ends while the wait waits on the builder's deadlock answer. */
export function deadlockWaitInstruction(
  db: DbReader,
  kind: ClaimKind,
  name: string,
  heldBy: WorkstreamId,
): string {
  return `Waiting would deadlock: task "${taskTitleOf(db, heldBy)}" holds ${kind} ${name} and waits for a claim you hold. The builder was asked in the Inbox which task yields its claim or is cancelled, and this wait goes on until they answer. Call request_claim again with the same opId to keep waiting, and edit nothing in ${kind} ${name} until a call returns granted: true.`;
}

/** The refusal that tells an agent which claims the builder or 10db's rule made its task give up. */
export function yieldRefusal(
  db: DbReader,
  given: Yielded,
  asked: { readonly kind: ClaimKind; readonly name: string },
): ClaimResult {
  const list = given.claims.map((c) => `${c.kind} ${c.name}`).join(', ');
  if (given.queued && given.to !== null)
    return {
      granted: false,
      heldBy: null,
      inboxId: given.inboxId,
      yielded: true,
      queued: true,
      parked: false,
      instruction: `You gave up ${list} to task "${taskTitleOf(db, given.to)}" and are queued behind it. Commit what you changed in the claims you still hold. Your uncommitted edits in ${list} stay in your folder and stay yours; do not commit them. Call write_handoff naming what is left, then end your turn. 10db starts you again when that task finishes.`,
    };
  const opening =
    given.to === null
      ? `The builder answered a claim deadlock: this task gave up ${list}, which was released so the other task could go on.`
      : `This task and task "${taskTitleOf(db, given.to)}" each waited for a claim the other holds, so 10db had this one give up ${list}; that task has it now.`;
  return {
    granted: false,
    heldBy: null,
    inboxId: given.inboxId,
    yielded: true,
    queued: given.queued,
    parked: false,
    instruction: `${opening} You no longer hold ${list}: edit nothing there until request_claim grants it to you again. Your uncommitted edits there stay as they are and are still your own: the other task does not commit them, and to commit them you ask for ${list} again. You did not get ${asked.kind} ${asked.name} either. Call request_claim with a new opId for each claim you still need.`,
  };
}

/**
 * What a task queued behind `behind` is answered at once when it asks for any claim: the contested claims
 * it no longer holds, and that it hands off.
 */
export function queuedRefusal(
  db: DbReader,
  me: WorkstreamId,
  behind: WorkstreamId,
  asked: { readonly kind: ClaimKind; readonly name: string },
): ClaimResult {
  const held = activeClaims(db, me);
  const claims = (readPair(db, me, behind)?.contested ?? []).filter(
    (claim) => !held.some((row) => row.kind === claim.kind && row.name === claim.name),
  );
  return yieldRefusal(db, { claims, inboxId: null, to: behind, queued: true }, asked);
}

/**
 * The refusal for a claim held by a task the update drain has parked. It shows no wait and raises no
 * card, and request_claim answers it without recording it under the opId, because it holds only for now:
 * a later call with the same opId asks again. The agent is told to write a handoff before it ends its
 * turn, since a turn that ends without one finishes the step and sends unfinished work to the gate. The
 * handoff's fresh session waits at the hold, so no session is cut off by the update, and the task asks
 * again in that session after the update.
 */
function parkedRefusal(a: Asking, heldBy: WorkstreamId): ClaimResult {
  return {
    granted: false,
    heldBy,
    inboxId: null,
    yielded: false,
    queued: false,
    parked: true,
    instruction: `Task "${taskTitleOf(a.state.db, heldBy)}" holds ${a.kind} ${a.name} and is paused until 10db's update has installed, so it will not free it soon. You did not get ${a.kind} ${a.name}. Edit nothing in it. If you can finish without it, carry on. Otherwise commit any changes you have, call write_handoff naming what is left under progress.notDone, and end your turn: a fresh session of this step continues after the update and can ask again then.`,
  };
}

/**
 * The refusal when a sign-off waits for this lane's turn to end (Workbench spec §9.2 step 0) and the
 * claim is held by the page being signed off: neither could move, so the lane is answered at once
 * and its turn can end. Null when no such sign-off waits.
 */
function signingOffRefusal(a: Asking, holder: WorkstreamId): ClaimResult | null {
  const db = a.state.db;
  for (const wait of listSignOffWaits(db)) {
    if (getHold(db, wait.waitsFor).workstreamId !== a.workstreamId) continue;
    const signing = getTask(db, wait.taskId);
    if (signing.workstreamId !== holder) continue;
    return {
      granted: false,
      heldBy: holder,
      inboxId: null,
      yielded: false,
      queued: false,
      parked: false,
      instruction: `${signing.title} is being signed off; do without ${a.kind} ${a.name} or ask again after your turn.`,
    };
  }
  return null;
}

/** Whether the task reached a terminal state: it takes no part in a deadlock any more. */
const taskEnded =
  (db: DbReader) =>
  (id: WorkstreamId): boolean =>
    isTerminal(getWorkstreamRow(db, id).state);

const cardOpen = (a: Asking, id: InboxItemId): boolean =>
  getInboxItem(a.state.db, id).state === InboxState.Open;

/** A deadlock card for this claim describes a deadlock that is gone once a later ask needs no refusal. */
function withdrawDeadlock(a: Asking): void {
  const card = findOpenByFoldKey(a.state.db, a.projectId, deadlockKey(a));
  if (card) a.inbox.withdraw(card.id);
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
 * Takes the claim, or waits for the holder to free it and takes it then. The wait shows a notice on the
 * waiting task that names the holder's task; it is cleared when the wait ends.
 *
 * When the holder itself waits, through any chain, for something this task holds (checked whenever the
 * holder changes), neither would ever move. This wait is the later asker, since the holder was already
 * waiting, and `deadlockMove` decides what it does; while it is in the deadlock the check runs on every
 * look, and a deadlock that ended by itself turns this into a plain wait. Under 2 minutes it shows that
 * it waits on a task that waits on it. After that it gives up what the holder waits for (`breakDeadlock`)
 * and ends with the yield's refusal; the holder's wait takes the claim at its next look. With the rule
 * set to ask, a card asks the builder which task yields its claim or is cancelled instead, and the wait
 * waits on the card: an answer that frees the claim lets this wait take it, and a card closed while the
 * deadlock stands is raised again. The earlier asker never looks again, so one deadlock yields once and
 * raises one card.
 *
 * A wait whose task the builder or the rule made yield claims (`ClaimWaits.yielded`) ends with a refusal
 * naming them. Starting to wait on a holder, or on a new one, tells `waits`, so the scheduler can give that
 * holder a lane. Runs synchronously up to its first wait, so `wait` names the holder and card by the
 * time `ClaimWaits.join` returns.
 *
 * A pass lane's shared area (`Asking.shared`) asks the builder first when it needs to, and the open
 * question, named on `wait`, holds the wait until it is answered. It then looks at the claim in the
 * same synchronous way and waits on a holder as above; only a free claim goes to the grant, which
 * records the hold before it takes the claim, so it answers asynchronously. An area is held only for
 * a turn: once the lane's turn has ended the wait withdraws its question and ends with nothing.
 */
async function claimOrWait(a: Asking, wait: WaitState, waits: ClaimWaits): Promise<ClaimResult> {
  const noticeKey = waitNoticeKey(a);
  const ended = taskEnded(a.state.db);
  let heldBy: WorkstreamId | null = null;
  let noticeShown = false;
  /** When this wait found the deadlock it is in; null while it is in none. */
  let deadlockSince: number | null = null;
  /** The notice shown is the deadlock's, so a poll that finds it again writes nothing. */
  let deadlockNoticeShown = false;
  const showNotice = (notice: Notice | null): void => {
    if (notice === null && !noticeShown) return;
    noticeShown = notice !== null;
    // Only this wait's own notice: a wait of the same task for another claim may have replaced it.
    a.state.write((ctx) => {
      if (notice !== null || getWorkstreamRow(ctx.tx, a.workstreamId).notice?.key === noticeKey)
        setWorkstreamNotice(ctx, a.workstreamId, notice);
    });
  };
  try {
    const shared = a.shared;
    const asked = shared && heldNow(a)?.ok !== true ? shared.ask() : null;
    if (shared && asked) {
      wait.askId = asked.inboxId;
      let refused: ClaimResult | null;
      try {
        refused = await answerOrTurnEnd({ ...a, shared }, asked);
      } catch {
        throw new InvalidError(
          'This session stopped waiting for the builder’s answer and did not get the claim. End your turn.',
        );
      } finally {
        wait.askId = null;
      }
      if (refused) return refused;
    }
    for (;;) {
      if (waits.isCancelled(a.workstreamId))
        throw new InvalidError('The builder cancelled this task. End your turn.');
      if (ended(a.workstreamId))
        throw new InvalidError(
          'This task has ended, so it no longer waits for the claim. End your turn.',
        );
      const given = waits.pendingYield(a.workstreamId);
      if (given) return yieldRefusal(a.state.db, given, a);
      // A shared area is held for a turn: a wait outlived by its turn takes nothing.
      if (shared && !shared.turnOpen()) return turnEndedRefusal(a, null);
      const tried =
        shared === undefined
          ? tryAcquire(a)
          : { outcome: heldNow(a) ?? (await shared.grant()), takenFrom: null };
      const outcome = tried.outcome;
      if (outcome === null) return turnEndedRefusal(a, null);
      if (outcome.ok) {
        withdrawDeadlock(a);
        // Recorded inside the wait, so a grant that lands between two calls still records it. A claim
        // taken from a queued task hands over its edits as a release would.
        const from = tried.takenFrom ?? heldBy;
        const handed =
          from === null
            ? null
            : { from, paths: await a.handOver(from).catch(() => [] as readonly string[]) };
        return grantedFrom(a, outcome.claims, handed);
      }
      const holder = outcome.conflict.heldBy;
      // A page whose sign-off waits for this turn frees nothing until the turn ends: no wait on it.
      const signing = signingOffRefusal(a, holder);
      if (signing) {
        withdrawDeadlock(a);
        return signing;
      }
      // A holder the update drain parked frees nothing until the update has installed, and the update
      // waits for this session to end: refuse instead of waiting, and the session ends by itself.
      if (waits.holderParked(holder)) return parkedRefusal(a, holder);
      const changed = holder !== heldBy;
      if (changed || wait.inboxId !== null || deadlockSince !== null) {
        if (!waits.waitsOn(holder, a.workstreamId, ended)) {
          withdrawDeadlock(a);
          wait.inboxId = null;
          deadlockSince = null;
          deadlockNoticeShown = false;
          showNotice(waitNotice(a, holder));
        } else {
          deadlockSince ??= a.now();
          const gives = waits.claimsAwaitedFrom(a.workstreamId, holder);
          const move = deadlockMove({
            asking: isRuleAsking(a.state.db, a.projectId, DecisionRule.ClaimDeadlock),
            ageMs: a.now() - deadlockSince,
            breaks: readPair(a.state.db, a.workstreamId, holder)?.breaks ?? 0,
            gives: gives.length,
          });
          switch (move) {
            case DeadlockMove.Card:
              if (changed || wait.inboxId === null || !cardOpen(a, wait.inboxId)) {
                wait.inboxId = deadlock(a, holder, waits);
                deadlockNoticeShown = false;
                showNotice(null);
              }
              break;
            case DeadlockMove.Wait:
              if (wait.inboxId !== null) {
                withdrawDeadlock(a);
                wait.inboxId = null;
              }
              if (changed || !deadlockNoticeShown) {
                showNotice(deadlockWaitNotice(a, holder));
                deadlockNoticeShown = true;
              }
              break;
            case DeadlockMove.Yield:
            case DeadlockMove.YieldAndQueue:
            case DeadlockMove.YieldQueueAndReport:
              // The loop's top answers the refusal.
              if (breakDeadlock(a, holder, gives, waits, move)) continue;
              break;
          }
        }
      }
      if (changed) {
        heldBy = holder;
        wait.heldBy = holder;
        waits.waitingOn();
      }
      await sleep(a.pollMs, a.signal);
      if (a.signal.aborted)
        throw new InvalidError(
          'This session stopped waiting for the claim and did not get it. End your turn.',
        );
    }
  } finally {
    // A card still up when the wait ends asks about a deadlock this wait no longer stands in: the
    // session stopped, or the task was cancelled. An answer to it would free nothing.
    if (wait.inboxId !== null && cardOpen(a, wait.inboxId)) a.inbox.withdraw(wait.inboxId);
    wait.heldBy = null;
    wait.inboxId = null;
    showNotice(null);
  }
}

function grantedFrom(
  a: Asking,
  claims: readonly ClaimRow[],
  handed: { readonly from: WorkstreamId; readonly paths: readonly string[] } | null,
): ClaimResult {
  const claim = claims.find((c) => c.kind === a.kind && c.name === a.name);
  if (!claim) throw new InvalidError('Claim was granted but not found');
  return { granted: true, claim, handed };
}
