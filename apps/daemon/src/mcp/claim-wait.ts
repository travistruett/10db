import {
  EventType,
  InboxKind,
  InboxState,
  InvalidError,
  isTerminal,
  WorkstreamId,
  WorkstreamState,
  type ClaimKind,
  type InboxItemDto,
  type InboxItemId,
  type Notice,
  type ProjectId,
} from '@10db/contracts';
import {
  acquireClaims,
  clearWorkstreamNotices,
  copyHazardNames,
  findOpenByFoldKey,
  getProject,
  getTask,
  getWorkstream,
  getInboxItem,
  getWorkstreamRow,
  listInbox,
  setWorkstreamNotice,
  type ClaimRow,
  type DbReader,
} from '@10db/db';
import { claimScopeOf } from '../delivery';
import type { EventBus, StateStore } from '../events';
import type { InboxService } from '../inbox';
import { DEADLOCK_DETAIL, deadlockAnswers } from './claim-deadlock';

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
  | {
      readonly granted: false;
      readonly heldBy: WorkstreamId | null;
      readonly inboxId: InboxItemId | null;
      /** What the refused agent does next. */
      readonly instruction: string;
      /** The refusal tells the agent about claims the builder made its task yield (`ClaimWaits.yielded`). */
      readonly yielded: boolean;
      /** The holder is parked for the update: true only now, so the answer is not kept under the opId. */
      readonly parked: boolean;
    };

/** Claims the builder made a task give up to end a claim deadlock, until its agent is told. */
export interface Yielded {
  readonly claims: readonly { readonly kind: ClaimKind; readonly name: string }[];
  readonly inboxId: InboxItemId;
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
}

/** Where a wait in progress stands: who holds the claim now. */
export interface WaitState {
  readonly workstreamId: WorkstreamId;
  readonly kind: ClaimKind;
  readonly name: string;
  heldBy: WorkstreamId | null;
  /** The open deadlock card this wait waits on for the builder's answer, if any. */
  inboxId: InboxItemId | null;
}

/** A wait in progress and how it ends. */
export interface LiveWait {
  readonly state: WaitState;
  readonly done: Promise<ClaimResult>;
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
    if (existing) return existing;
    const state: WaitState = {
      workstreamId: a.workstreamId,
      kind: a.kind,
      name: a.name,
      heldBy: null,
      inboxId: null,
    };
    const done = claimOrWait(a, state, this).finally(() => {
      this.#live.delete(key);
      if (![...this.#live.values()].some((w) => w.state.workstreamId === a.workstreamId))
        this.#cancelled.delete(a.workstreamId);
    });
    done.catch(() => undefined);
    const entry = { state, done };
    this.#live.set(key, entry);
    return entry;
  }

  /**
   * The builder made `workstreamId` give up `claims` to end a deadlock. Its waits end with a refusal
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
   * `start` waits on through other waiters: what `holder` gives up to unblock `start`.
   */
  claimsAwaitedFrom(
    holder: WorkstreamId,
    start: WorkstreamId,
  ): { readonly kind: ClaimKind; readonly name: string }[] {
    const out: { readonly kind: ClaimKind; readonly name: string }[] = [];
    for (const { state } of this.#live.values())
      if (
        state.heldBy === holder &&
        (state.workstreamId === start || this.waitsOn(start, state.workstreamId))
      )
        out.push({ kind: state.kind, name: state.name });
    return out;
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
 * build raised, which a task's card shows instead now.
 */
export function withdrawStaleClaimWaits(state: StateStore, inbox: InboxService): void {
  state.write((ctx) => clearWorkstreamNotices(ctx));
  for (const item of listInbox(state.db, { states: [InboxState.Open] }))
    if (item.kind === InboxKind.Flag && (isWaitCard(item) || isDeadlockCard(item)))
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
  const body = `Task "${holder}" holds ${a.kind} ${a.name} and is itself waiting for a claim that task "${asker}" holds, so neither can go on. Reason given: ${a.reason}`;
  const card = a.inbox.flag({
    projectId: a.projectId,
    workstreamId: a.workstreamId,
    title: `Claim deadlock: ${a.kind} ${a.name}`,
    body,
    options,
    detail: { heldBy, ...detail },
    foldKey: deadlockKey(a),
    refresh: true,
  });
  // A repeat that folds keeps the options it was raised with; another holder needs other answers.
  if (card.options.map((o) => o.label).join('\n') !== options.map((o) => o.label).join('\n'))
    a.inbox.reword(card.id, body, { options, detail: { heldBy, ...detail } });
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

/** The refusal that tells an agent which claims the builder made its task give up. */
export function yieldRefusal(
  given: Yielded,
  asked: { readonly kind: ClaimKind; readonly name: string },
): ClaimResult {
  const list = given.claims.map((c) => `${c.kind} ${c.name}`).join(', ');
  return {
    granted: false,
    heldBy: null,
    inboxId: given.inboxId,
    yielded: true,
    parked: false,
    instruction: `The builder answered a claim deadlock: this task gave up ${list}, which was released so the other task could go on. You no longer hold ${list}: edit nothing there until request_claim grants it to you again. You did not get ${asked.kind} ${asked.name} either. Call request_claim with a new opId for each claim you still need.`,
  };
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
    parked: true,
    instruction: `Task "${taskTitleOf(a.state.db, heldBy)}" holds ${a.kind} ${a.name} and is paused until 10db's update has installed, so it will not free it soon. You did not get ${a.kind} ${a.name}. Edit nothing in it. If you can finish without it, carry on. Otherwise commit any changes you have, call write_handoff naming what is left, and end your turn: a fresh session of this step continues after the update and can ask again then.`,
  };
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
 * holder changes), neither would ever move: a card asks the builder which task yields its claim or is
 * cancelled, and the wait goes on, waiting on the card. While the card is up the check runs on every
 * look: an answer that frees the claim lets this wait take it, a deadlock that ended by itself withdraws
 * the card and turns this into a plain wait, and a card closed while the deadlock stands is raised again.
 * Only the waiter whose card is up looks again, so one deadlock raises one card.
 *
 * A wait whose task the builder made yield claims (`ClaimWaits.yielded`) ends with a refusal naming
 * them. Starting to wait on a holder, or on a new one, tells `waits`, so the scheduler can give that
 * holder a lane. Runs synchronously up to its first wait, so `wait` names the holder and card by the
 * time `ClaimWaits.join` returns.
 */
async function claimOrWait(a: Asking, wait: WaitState, waits: ClaimWaits): Promise<ClaimResult> {
  const noticeKey = waitNoticeKey(a);
  const ended = taskEnded(a.state.db);
  let heldBy: WorkstreamId | null = null;
  let noticeShown = false;
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
    for (;;) {
      if (waits.isCancelled(a.workstreamId))
        throw new InvalidError('The builder cancelled this task. End your turn.');
      if (ended(a.workstreamId))
        throw new InvalidError(
          'This task has ended, so it no longer waits for the claim. End your turn.',
        );
      const given = waits.pendingYield(a.workstreamId);
      if (given) return yieldRefusal(given, a);
      const outcome = tryAcquire(a);
      if (outcome.ok) {
        withdrawDeadlock(a);
        return grantedFrom(a, outcome.claims);
      }
      const holder = outcome.conflict.heldBy;
      // A holder the update drain parked frees nothing until the update has installed, and the update
      // waits for this session to end: refuse instead of waiting, and the session ends by itself.
      if (waits.holderParked(holder)) return parkedRefusal(a, holder);
      const changed = holder !== heldBy;
      if (changed || wait.inboxId !== null) {
        if (!waits.waitsOn(holder, a.workstreamId, ended)) {
          withdrawDeadlock(a);
          wait.inboxId = null;
          showNotice(waitNotice(a, holder));
        } else if (changed || wait.inboxId === null || !cardOpen(a, wait.inboxId)) {
          wait.inboxId = deadlock(a, holder, waits);
          showNotice(null);
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

function grantedFrom(a: Asking, claims: readonly ClaimRow[]): ClaimResult {
  const claim = claims.find((c) => c.kind === a.kind && c.name === a.name);
  if (!claim) throw new InvalidError('Claim was granted but not found');
  return { granted: true, claim };
}
