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
import type { StateStore } from '../events';
import { exclusion, limitsOf } from './exclusion';

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
}
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
}

export interface FolderHoldDeps {
  readonly state: StateStore;
}

export function createFolderHold(deps: FolderHoldDeps): FolderHold {
  const turns = new Map<ChatId, TurnEntry>();
  const gits = new Map<symbol, GitEntry>();

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

  const blockers = (projectId: ProjectId, asker: FolderAskerInput): FolderBlocker[] =>
    holders(projectId, 'chatId' in asker ? asker.chatId : undefined).flatMap((holder) => {
      const outcome = exclusion(holder.kind, asker.kind);
      return outcome === FolderOutcome.Shares ? [] : [{ holder, outcome }];
    });

  return {
    holders,
    blockers,
    takeTurn(projectId, chatId) {
      const mine = turns.get(chatId);
      const others = holders(projectId, chatId);
      if (!mine) {
        const blocked = blockers(projectId, { kind: FolderAsker.ChatTurn, chatId });
        if (blocked.length > 0) return { taken: false, blockers: blocked };
        turns.set(chatId, { projectId, chatId });
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
    },
    holdsTurn: (chatId) => turns.has(chatId),
    reserveGit(projectId, what) {
      const blocked = blockers(projectId, { kind: FolderAsker.GitWork });
      if (blocked.length > 0) return { reserved: false, blockers: blocked };
      const token = Symbol(what);
      gits.set(token, { projectId, what });
      changed(projectId);
      return { reserved: true, token };
    },
    releaseGit(token) {
      const mine = gits.get(token);
      if (!mine) return;
      gits.delete(token);
      changed(mine.projectId);
    },
  };
}
