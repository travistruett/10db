import {
  EventType,
  FolderAsker,
  FolderHolderKind,
  FolderOutcome,
  CHAT_DEFAULT_TITLE,
  OPEN_PASS_STATES,
  type ChatId,
  type FolderHolderDto,
  type FolderLimit,
  type ProjectId,
} from '@10db/contracts';
import { folderLanes, getChat, passHoldingFolder, takenOverChats } from '@10db/db';
import type { EventBus, StateStore } from '../events';
import { exclusion, limitsOf } from './exclusion';

/** What `reserveGitWhenFree` rejects with when its wait is cancelled. */
export class FolderWaitCancelledError extends Error {
  override readonly name = 'FolderWaitCancelledError';
  constructor() {
    super('the wait for Your folder was cancelled');
  }
}

/** Who is asking: a lane's first start, 10db's own git work, or an attended chat's turn or takeover. */
export type FolderAskerInput =
  | { readonly kind: typeof FolderAsker.LaneStart }
  | { readonly kind: typeof FolderAsker.GitWork }
  | { readonly kind: typeof FolderAsker.ChatTurn; readonly chatId: ChatId }
  | { readonly kind: typeof FolderAsker.Takeover; readonly chatId: ChatId };

/** A holder that keeps the asker out, and what it does to it. */
export interface FolderBlocker {
  readonly holder: FolderHolderDto;
  readonly outcome: FolderOutcome;
}

export interface TurnTaken {
  readonly taken: true;
  /** The attended holders the turn shares the folder with, each to be named in the warning. */
  readonly sharedWith: readonly FolderHolderDto[];
  readonly limits: readonly FolderLimit[];
  /** The closed pass the limits wait on. */
  readonly limitPass: string | null;
}
export interface TurnBlocked {
  readonly taken: false;
  readonly blockers: readonly FolderBlocker[];
}

export type GitReservation =
  | { readonly reserved: true; readonly token: symbol }
  | { readonly reserved: false; readonly blockers: readonly FolderBlocker[] };

interface TurnEntry {
  readonly projectId: ProjectId;
  readonly chatId: ChatId;
  /** Put on a waiter that was served: its turn has not begun, and goes at once if none does. */
  reserved: boolean;
}
interface Waiter {
  readonly projectId: ProjectId;
  readonly chatId: ChatId;
  serve: () => ServeResult;
}

/**
 * What serving a waiter did: its turn `began`; it `kept` waiting because nothing could start (the account is
 * paused, or the update hold is on); or it is `dropped` (the chat was retired, or nothing was left to send).
 */
export type ServeResult = 'began' | 'kept' | 'dropped';

/** Events after which a waiter's turn may be able to start. */
const SERVE_AFTER: ReadonlySet<string> = new Set([
  EventType.WorkstreamChanged,
  EventType.BatchUpdated,
  EventType.PassOpened,
  EventType.PassChanged,
  EventType.PassClosed,
  EventType.PassSettled,
  EventType.ConversationState,
  EventType.AccountSaved,
  EventType.AccountResumed,
  EventType.AccountCapReached,
]);
interface GitEntry {
  readonly projectId: ProjectId;
  readonly what: string;
}

/**
 * Who holds each project's checkout (sessions spec §7.3). A pass, a lane and a takeover are read from rows, so a
 * restart keeps them; a chat's turn and 10db's git work in progress live in memory and end with the daemon.
 */
export interface FolderHold {
  /** Every holder of the project's checkout, but `except`'s own turn. */
  holders(projectId: ProjectId, except?: ChatId): FolderHolderDto[];
  /** The holders that keep `asker` out, in the order `holders` lists them. */
  blockers(projectId: ProjectId, asker: FolderAskerInput): FolderBlocker[];
  /** Takes the folder for the chat's turn, or says who is in the way. Idempotent for a chat that holds it. */
  takeTurn(projectId: ProjectId, chatId: ChatId): TurnTaken | TurnBlocked;
  /** Gives the folder back. Idempotent. */
  releaseTurn(chatId: ChatId): void;
  holdsTurn(chatId: ChatId): boolean;
  /** Reserves the folder for 10db's own git work, or says who is in the way. */
  reserveGit(projectId: ProjectId, what: string): GitReservation;
  releaseGit(token: symbol): void;
  /**
   * Reserves the folder for 10db's git work, waiting for a chat's turn or a takeover to end first. It rejects
   * when `signal` aborts.
   */
  reserveGitWhenFree(projectId: ProjectId, what: string, signal?: AbortSignal): Promise<symbol>;
  /**
   * Parks the chat's message until the folder frees. Each time it can run, `serve` is called with the folder
   * reserved for the chat; a chat already waiting keeps its place. Served at once when nothing is in the way.
   */
  wait(projectId: ProjectId, chatId: ChatId, serve: () => ServeResult): void;
  /** Stops waiting, and gives back a reservation whose turn never began. Idempotent. */
  cancelWait(chatId: ChatId): void;
  /** The chat's next turn reads only, whatever the folder is by then: the builder chose Send Reading Only. */
  chooseReadOnly(chatId: ChatId): void;
  /** Whether the choice was made, taking it: it covers one turn. */
  takeReadOnlyChoice(chatId: ChatId): boolean;
  waiting(chatId: ChatId): boolean;
  /** Serves every waiter that can run now: after an account or the update hold changes. */
  serveWaiters(): void;
  /** Stops listening to the bus. */
  close(): void;
}

export interface FolderHoldDeps {
  readonly state: StateStore;
  /** Serves waiters when a lane, a pass, a batch or an account changes. */
  readonly bus: EventBus;
}

export function createFolderHold(deps: FolderHoldDeps): FolderHold {
  const turns = new Map<ChatId, TurnEntry>();
  const gits = new Map<symbol, GitEntry>();
  const waiters: Waiter[] = [];
  const readOnlyChoices = new Set<ChatId>();

  const changed = (projectId: ProjectId): void => {
    deps.state.write((ctx) => {
      ctx.emit({
        type: EventType.FolderHoldChanged,
        entityType: 'project',
        entityId: projectId,
        data: {},
      });
    });
  };

  const chatTitle = (chatId: ChatId): string =>
    getChat(deps.state.db, chatId).title ?? CHAT_DEFAULT_TITLE;

  const holders = (projectId: ProjectId, except?: ChatId): FolderHolderDto[] => {
    const db = deps.state.db;
    const out: FolderHolderDto[] = [];
    const pass = passHoldingFolder(db, projectId);
    if (pass)
      out.push({
        kind: OPEN_PASS_STATES.includes(pass.state)
          ? FolderHolderKind.PassOpen
          : FolderHolderKind.PassClosed,
        name: pass.name,
        more: 0,
        chatId: null,
        what: null,
      });
    const lanes = folderLanes(db, projectId);
    const [first] = lanes;
    if (first)
      out.push({
        kind: FolderHolderKind.Lane,
        name: first.name,
        more: lanes.length - 1,
        chatId: null,
        what: null,
      });
    for (const chat of takenOverChats(db, projectId))
      if (chat.id !== except)
        out.push({
          kind: FolderHolderKind.Takeover,
          name: chat.title ?? CHAT_DEFAULT_TITLE,
          more: 0,
          chatId: chat.id,
          what: null,
        });
    for (const entry of gits.values())
      if (entry.projectId === projectId)
        out.push({
          kind: FolderHolderKind.GitWork,
          name: '',
          more: 0,
          chatId: null,
          what: entry.what,
        });
    for (const entry of waiters)
      if (entry.projectId === projectId && entry.chatId !== except && !turns.has(entry.chatId))
        out.push({
          kind: FolderHolderKind.WaitingChat,
          name: chatTitle(entry.chatId),
          more: 0,
          chatId: entry.chatId,
          what: null,
        });
    for (const entry of turns.values())
      if (entry.projectId === projectId && entry.chatId !== except)
        out.push({
          kind: FolderHolderKind.ChatTurn,
          name: chatTitle(entry.chatId),
          more: 0,
          chatId: entry.chatId,
          what: null,
        });
    return out;
  };

  /** The callers of `reserveGitWhenFree` still waiting. */
  const freeing: { projectId: ProjectId; what: string; wake: () => void }[] = [];

  const blockers = (projectId: ProjectId, asker: FolderAskerInput): FolderBlocker[] => {
    const held = holders(projectId, 'chatId' in asker ? asker.chatId : undefined);
    // 10db's git work that waits for the folder keeps a new chat turn out, so chats that share the folder
    // can't hold it from that work for ever. Other git work counts only once it holds.
    if ('chatId' in asker)
      for (const entry of freeing)
        if (entry.projectId === projectId)
          held.push({
            kind: FolderHolderKind.GitWork,
            name: '',
            more: 0,
            chatId: null,
            what: entry.what,
          });
    return held.flatMap((holder) => {
      const outcome = exclusion(holder.kind, asker.kind);
      return outcome === FolderOutcome.Shares ? [] : [{ holder, outcome }];
    });
  };

  /** Wakes each caller of `reserveGitWhenFree` that nothing now keeps out. */
  const flushFree = (): void => {
    for (const entry of [...freeing]) {
      if (blockers(entry.projectId, { kind: FolderAsker.GitWork }).length > 0) continue;
      freeing.splice(freeing.indexOf(entry), 1);
      entry.wake();
    }
  };

  const reserveGit = (projectId: ProjectId, what: string): GitReservation => {
    const blocked = blockers(projectId, { kind: FolderAsker.GitWork });
    if (blocked.length > 0) return { reserved: false, blockers: blocked };
    const token = Symbol(what);
    gits.set(token, { projectId, what });
    changed(projectId);
    return { reserved: true, token };
  };

  let serving = false;
  let again = false;
  // Read through a function: a serve that reenters sets it, which the loop's own flow can't see.
  const askedAgain = (): boolean => again;
  /** Serves each waiter, oldest first, that nothing now keeps out, holding the folder for it meanwhile. */
  const serveWaiters = (): void => {
    if (serving) {
      again = true;
      return;
    }
    serving = true;
    try {
      do {
        again = false;
        for (const waiter of [...waiters]) {
          if (!waiters.includes(waiter)) continue;
          if (
            blockers(waiter.projectId, { kind: FolderAsker.ChatTurn, chatId: waiter.chatId })
              .length > 0
          )
            continue;
          // A chat in the middle of its turn is served when that turn ends, not over it.
          if (turns.get(waiter.chatId)?.reserved === false) continue;
          turns.set(waiter.chatId, {
            projectId: waiter.projectId,
            chatId: waiter.chatId,
            reserved: true,
          });
          // A serve that throws leaves the chat waiting and gives the reservation back.
          const served: { result: ServeResult | 'threw' } = { result: 'threw' };
          try {
            served.result = waiter.serve();
          } finally {
            if (served.result !== 'began' && turns.get(waiter.chatId)?.reserved === true)
              turns.delete(waiter.chatId);
            if (served.result === 'dropped' || served.result === 'began') {
              const at = waiters.indexOf(waiter);
              if (at >= 0) waiters.splice(at, 1);
            }
            // A waiter that stays kept has changed nothing anyone can see.
            if (served.result !== 'kept') changed(waiter.projectId);
          }
        }
      } while (askedAgain());
    } finally {
      serving = false;
    }
    flushFree();
  };
  const unsubscribe = deps.bus.subscribe((event) => {
    if (SERVE_AFTER.has(event.type)) serveWaiters();
  });

  return {
    holders,
    blockers,
    serveWaiters,
    close: unsubscribe,
    wait(projectId, chatId, serve) {
      const mine = waiters.find((w) => w.chatId === chatId);
      if (mine) mine.serve = serve;
      else {
        waiters.push({ projectId, chatId, serve });
        changed(projectId);
      }
      serveWaiters();
    },
    chooseReadOnly: (chatId) => {
      readOnlyChoices.add(chatId);
    },
    takeReadOnlyChoice: (chatId) => readOnlyChoices.delete(chatId),
    cancelWait(chatId) {
      readOnlyChoices.delete(chatId);
      const at = waiters.findIndex((w) => w.chatId === chatId);
      const reservation = turns.get(chatId);
      if (at < 0 && reservation?.reserved !== true) return;
      const projectId = at >= 0 ? waiters[at]?.projectId : reservation?.projectId;
      if (at >= 0) waiters.splice(at, 1);
      if (reservation?.reserved === true) turns.delete(chatId);
      if (projectId) changed(projectId);
      serveWaiters();
    },
    waiting: (chatId) => waiters.some((w) => w.chatId === chatId),
    async reserveGitWhenFree(projectId, what, signal) {
      for (;;) {
        if (signal?.aborted === true) throw new FolderWaitCancelledError();
        const reserved = reserveGit(projectId, what);
        if (reserved.reserved) return reserved.token;
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            const at = freeing.indexOf(entry);
            if (at >= 0) freeing.splice(at, 1);
            reject(new FolderWaitCancelledError());
          };
          const entry = {
            projectId,
            what,
            wake: () => {
              signal?.removeEventListener('abort', onAbort);
              resolve();
            },
          };
          freeing.push(entry);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
    },
    takeTurn(projectId, chatId) {
      const mine = turns.get(chatId);
      const others = holders(projectId, chatId);
      if (!mine) {
        const blocked = blockers(projectId, { kind: FolderAsker.ChatTurn, chatId });
        if (blocked.length > 0) return { taken: false, blockers: blocked };
        turns.set(chatId, { projectId, chatId, reserved: false });
        try {
          changed(projectId);
        } catch (error) {
          // A take that could not say so is not a take.
          turns.delete(chatId);
          throw error;
        }
      }
      const reservation = turns.get(chatId);
      if (reservation) reservation.reserved = false;
      // A chat that takes the folder is no longer waiting for it.
      const waiter = waiters.findIndex((w) => w.chatId === chatId);
      if (waiter >= 0) {
        waiters.splice(waiter, 1);
        changed(projectId);
      }
      const limits = [...new Set(others.flatMap((h) => limitsOf(h.kind)))];
      return {
        taken: true,
        sharedWith: others.filter(
          (h) => h.kind === FolderHolderKind.ChatTurn || h.kind === FolderHolderKind.Takeover,
        ),
        limits,
        limitPass: others.find((h) => h.kind === FolderHolderKind.PassClosed)?.name ?? null,
      };
    },
    releaseTurn(chatId) {
      const mine = turns.get(chatId);
      if (!mine) return;
      turns.delete(chatId);
      changed(mine.projectId);
      serveWaiters();
    },
    holdsTurn: (chatId) => turns.has(chatId),
    reserveGit,
    releaseGit(token) {
      const mine = gits.get(token);
      if (!mine) return;
      gits.delete(token);
      changed(mine.projectId);
      serveWaiters();
    },
  };
}
