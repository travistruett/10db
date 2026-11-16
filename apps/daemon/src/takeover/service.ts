import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictError,
  ConversationId,
  ConversationState,
  FolderAsker,
  FolderHolderKind,
  TerminalApp,
  UpstreamError,
  type AgentAccountKind,
  type ChatId,
  type ProjectDto,
  type TakeoverCommandDto,
  type TakeoverDto,
  type TakeoverPreviewDto,
} from '@10db/contracts';
import {
  chatOfConversation,
  getChat,
  getConversation,
  getProject,
  type ChatRow,
  type ConversationRow,
} from '@10db/db';
import type { ChatService } from '../chat';
import { openTerminalRefusal, type ExploreEngine } from '../conversation';
import type { StateStore } from '../events';
import { holderWords, type FolderBlocker, type FolderHold } from '../folder-hold';
import type { Logger } from '../log';
import { TakeoverRefusedError } from '../sessions';
import {
  createTakeoverFolder,
  readTakeoverRecord,
  removeTakeoverFolder,
  takeoverFolderOf,
  TAKEOVERS,
  writeTakeoverRecord,
  type TakeoverRecord,
} from './files';
import type { TerminalOpener } from './opener';
import type { PrepareInput, PreparedTakeover, TakeoverSource } from './prepare';
import { settingFilesChanged } from './setting-files';

// Sessions spec §7.5: a chat's move to the builder's own terminal and back. Every call for one chat runs in order
// on that chat's chain, so an open, a second window, Copy the Command, Hand Back and archive never interleave;
// messages and Stop go to the engine, which refuses them by state.

const NOT_IN_TERMINAL = 'Not in your terminal';
const ARCHIVED = 'This chat is archived';
const NOT_A_CHAT = 'Only a chat opens in your terminal for now';
const FOLDER_HELD_NOTE = 'Your folder is held until you hand back.';
const closedPassNote = (name: string): string =>
  `The pass ‘${name}’ is closed and waits for its pull request to merge: a commit made in the terminal makes its settle ask you.`;

export interface TakeoverServiceDeps {
  readonly state: StateStore;
  readonly engine: ExploreEngine;
  readonly folderHold: FolderHold;
  /** Hand Back parks the held messages on the folder through the chat service. */
  readonly chats: () => Pick<ChatService, 'watchFolder'>;
  readonly dataDir: string;
  readonly now: () => Date;
  readonly log: Logger;
  /** The app Open in Terminal opens, read at each open. */
  readonly app: () => TerminalApp;
  readonly opener: TerminalOpener;
  /** What the chat's session ran with; throws, with words, when its account can't start one. */
  sourceOf(conv: ConversationRow, project: ProjectDto): TakeoverSource;
  /** Writes one set of files for the chat's terminal. */
  prepare(input: PrepareInput, signal: AbortSignal): Promise<PreparedTakeover>;
  /** What the agent's terminal does and doesn't have, in words. */
  notesOf(kind: AgentAccountKind): string[];
  /** The paths of the checkout that differ from HEAD, relative to it. */
  changedPaths(checkout: string): Promise<string[]>;
}

export interface TakeoverService {
  /** Opens the chat in the builder's terminal; a chat already there opens another window. */
  open(conversationId: ConversationId): Promise<TakeoverDto>;
  /** A fresh command for a chat that is in the terminal, to paste. */
  command(conversationId: ConversationId): Promise<TakeoverCommandDto>;
  /** Gives the chat back; what was typed meanwhile runs, after 10db's own git work. */
  handBack(conversationId: ConversationId): Promise<void>;
  /** Whether Open would go ahead, and what the builder is told first. */
  preview(conversationId: ConversationId): Promise<TakeoverPreviewDto>;
  /** The chat's takeover, or null when it isn't in the terminal. */
  takeoverOf(conversationId: ConversationId): TakeoverDto | null;
  /** Runs `job` after the chat's earlier takeover calls (the chat's archive). */
  serialized<T>(chatId: ChatId, job: () => Promise<T>): Promise<T>;
  /** The chat is archived: its hold is released, waiters served and its files removed. */
  ended(chatId: ChatId): void;
  /** At start: removes the files of every chat that isn't in the terminal (an open the daemon lost). */
  recover(): void;
  /** At shutdown: aborts what prepares or opens, and waits for the chains. */
  stop(): Promise<void>;
}

interface Live {
  readonly sets: PreparedTakeover[];
}

export function createTakeoverService(deps: TakeoverServiceDeps): TakeoverService {
  const { state, engine, folderHold } = deps;
  const stopping = new AbortController();
  const chains = new Map<ChatId, Promise<unknown>>();
  const live = new Map<ChatId, Live>();

  function chatOf(conversationId: ConversationId): ChatRow {
    const chat = chatOfConversation(state.db, conversationId);
    if (chat === null) throw new ConflictError(NOT_A_CHAT);
    return chat;
  }

  function run<T>(chatId: ChatId, job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const earlier = chains.get(chatId) ?? Promise.resolve();
    const result = earlier.then(() => {
      stopping.signal.throwIfAborted();
      return job(stopping.signal);
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    chains.set(chatId, tail);
    void tail.then(() => {
      if (chains.get(chatId) === tail) chains.delete(chatId);
    });
    return result;
  }

  const blockedWords = (blockers: readonly FolderBlocker[]): string =>
    `Your folder is in use by ${blockers.map((b) => holderWords(b.holder)).join(' and ')}`;

  /** Why Open can't go ahead now, or null. A chat already in the terminal opens another window. */
  function refusalOf(chat: ChatRow): string | null {
    if (chat.archivedAt !== null) return ARCHIVED;
    const conv = getConversation(state.db, chat.conversationId);
    if (conv.state === ConversationState.TakenOver) return null;
    const words = openTerminalRefusal(
      conv.state ?? ConversationState.IdleCold,
      conv.providerSessionId !== null,
    );
    if (words !== null) return words;
    const blockers = folderHold.blockers(chat.projectId, {
      kind: FolderAsker.Takeover,
      chatId: chat.id,
    });
    return blockers.length > 0 ? blockedWords(blockers) : null;
  }

  function stateOf(chat: ChatRow): ConversationState | null {
    return getConversation(state.db, chat.conversationId).state;
  }

  /** Writes a set of files for the chat; the agent's refusal to start is the builder's to read. */
  async function prepare(chat: ChatRow, folder: string, signal: AbortSignal) {
    const conv = getConversation(state.db, chat.conversationId);
    const project = getProject(state.db, chat.projectId);
    const providerSessionId = conv.providerSessionId;
    if (providerSessionId === null) throw new ConflictError('Send a message first');
    try {
      return await deps.prepare(
        { project, source: deps.sourceOf(conv, project), providerSessionId, folder },
        signal,
      );
    } catch (error) {
      if (error instanceof TakeoverRefusedError) throw new ConflictError(error.message);
      throw error;
    }
  }

  /**
   * Removes everything of the chat's takeover: its sets' servers and the folder. One set that won't go is
   * logged and the rest still go, so the folder, which holds sealed headers, never stays for want of another.
   */
  function release(chat: ChatRow): void {
    const sets = live.get(chat.id)?.sets ?? [];
    live.delete(chat.id);
    try {
      for (const set of sets) {
        try {
          set.remove();
        } catch (error) {
          deps.log.warn({ err: error, chatId: chat.id }, 'a takeover set was not removed');
        }
      }
    } finally {
      removeTakeoverFolder(deps.dataDir, chat.conversationId);
    }
  }

  const notesFor = (chat: ChatRow, extra: readonly string[] = []): string[] => {
    const conv = getConversation(state.db, chat.conversationId);
    const kind = deps.sourceOf(conv, getProject(state.db, chat.projectId)).kind;
    return [...deps.notesOf(kind), ...extra];
  };

  async function launch(
    chat: ChatRow,
    folder: string,
    app: TerminalApp,
    signal: AbortSignal,
  ): Promise<{ set: PreparedTakeover; record: TakeoverRecord }> {
    const set = await prepare(chat, folder, signal);
    const earlier = readTakeoverRecord(folder);
    const tempDirs = [...new Set([...(earlier?.tempDirs ?? []), ...set.tempDirs])];
    const record: TakeoverRecord = {
      since: earlier?.since ?? deps.now().toISOString(),
      app,
      tempDirs,
    };
    try {
      writeTakeoverRecord(folder, record);
    } catch (error) {
      set.remove();
      throw error;
    }
    return { set, record };
  }

  async function openFresh(chat: ChatRow, signal: AbortSignal): Promise<TakeoverDto> {
    const app = deps.app();
    const folder = createTakeoverFolder(deps.dataDir, chat.conversationId);
    let set: PreparedTakeover | null = null;
    let record: TakeoverRecord;
    try {
      ({ set, record } = await launch(chat, folder, app, signal));
      signal.throwIfAborted();
      const taken = folderHold.takeOver(chat.projectId, chat.id, () => {
        // The archived row is read at the moment of the take: a chat archived before a restart has no
        // retired flag in the engine.
        if (getChat(state.db, chat.id).archivedAt !== null) throw new ConflictError(ARCHIVED);
        return engine.openTerminal(chat.conversationId);
      });
      if (!taken.taken) throw new ConflictError(blockedWords(taken.blockers));
      // A message waiting for the folder can't run while the chat is in the terminal; Hand Back parks it again.
      folderHold.cancelWait(chat.id);
      await taken.value.closed;
    } catch (error) {
      set?.remove();
      removeTakeoverFolder(deps.dataDir, chat.conversationId);
      throw error;
    }
    if (stateOf(chat) !== ConversationState.TakenOver) {
      set.remove();
      release(chat);
      throw new ConflictError('The chat changed while it opened');
    }
    live.set(chat.id, { sets: [set] });
    if (app !== TerminalApp.Copy) await openWindow(chat, set, app, signal, true);
    return dto(record, set.notes, app === TerminalApp.Copy ? set.line : null);
  }

  /** Hands the script to the app. A failure of the first window gives the chat back; a later one only says so. */
  async function openWindow(
    chat: ChatRow,
    set: PreparedTakeover,
    app: Exclude<TerminalApp, 'copy'>,
    signal: AbortSignal,
    first: boolean,
  ): Promise<void> {
    try {
      await deps.opener(app, set.script, signal);
    } catch (error) {
      // 10db stopping leaves the chat taken over, for Again or Hand Back.
      if (signal.aborted) throw error;
      deps.log.warn({ err: error, chatId: chat.id }, 'the terminal did not open');
      if (first) {
        folderHold.handBack(chat.projectId, chat.id, () => {
          engine.terminalFailed(chat.conversationId);
        });
        release(chat);
      } else {
        set.remove();
        const sets = live.get(chat.id)?.sets;
        const at = sets?.indexOf(set) ?? -1;
        if (at >= 0) sets?.splice(at, 1);
      }
      throw error instanceof UpstreamError
        ? error
        : new UpstreamError('The terminal did not open.');
    }
  }

  async function again(
    chat: ChatRow,
    signal: AbortSignal,
    open: boolean,
  ): Promise<{ dto: TakeoverDto; line: string }> {
    if (stateOf(chat) !== ConversationState.TakenOver) throw new ConflictError(NOT_IN_TERMINAL);
    const app = deps.app();
    const folder = createTakeoverFolder(deps.dataDir, chat.conversationId);
    const { set, record } = await launch(chat, folder, app, signal);
    const entry = live.get(chat.id) ?? { sets: [] };
    entry.sets.push(set);
    live.set(chat.id, entry);
    if (open && app !== TerminalApp.Copy) await openWindow(chat, set, app, signal, false);
    return {
      dto: dto(record, set.notes, open && app === TerminalApp.Copy ? set.line : null),
      line: set.line,
    };
  }

  function dto(record: TakeoverRecord, notes: readonly string[], line: string | null): TakeoverDto {
    return { since: record.since, app: record.app, notes: [...notes], line };
  }

  return {
    open(conversationId) {
      const chat = chatOf(conversationId);
      return run(chat.id, async (signal) => {
        const fresh = getChat(state.db, chat.id);
        const refusal = refusalOf(fresh);
        if (refusal !== null) throw new ConflictError(refusal);
        if (stateOf(fresh) === ConversationState.TakenOver)
          return (await again(fresh, signal, true)).dto;
        return openFresh(fresh, signal);
      });
    },

    command(conversationId) {
      const chat = chatOf(conversationId);
      return run(chat.id, async (signal) => ({
        line: (await again(getChat(state.db, chat.id), signal, false)).line,
      }));
    },

    handBack(conversationId) {
      const chat = chatOf(conversationId);
      return run(chat.id, () => {
        if (stateOf(chat) !== ConversationState.TakenOver)
          return Promise.reject(new ConflictError(NOT_IN_TERMINAL));
        // Held first, so a message typed meanwhile waits for the folder instead of running read only, and
        // 10db's git work that waited for the terminal goes first.
        engine.holdStarts(conversationId);
        try {
          folderHold.handBack(chat.projectId, chat.id, () => {
            engine.handBack(conversationId);
          });
        } catch (error) {
          engine.releaseStarts(conversationId);
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        deps.chats().watchFolder(conversationId);
        release(chat);
        return Promise.resolve();
      });
    },

    async preview(conversationId) {
      const chat = chatOf(conversationId);
      const refusal = refusalOf(chat);
      const project = getProject(state.db, chat.projectId);
      const notes = [FOLDER_HELD_NOTE];
      const closed = deps.folderHold
        .holders(chat.projectId)
        .find((holder) => holder.kind === FolderHolderKind.PassClosed);
      if (closed !== undefined) notes.push(closedPassNote(closed.name));
      try {
        const paths = await deps.changedPaths(project.repoPath).catch((error: unknown) => {
          // A git failure costs the list of changed files, not the terminal.
          deps.log.warn({ err: error, chatId: chat.id }, 'the changed files could not be read');
          return null;
        });
        if (paths === null)
          notes.push("Which project files changed couldn't be read, so none are listed here.");
        else {
          const changed = settingFilesChanged(paths, project.repoPath);
          if (changed.length > 0)
            notes.push(`These project files changed and won't be loaded: ${changed.join(', ')}.`);
        }
        notes.push(...notesFor(chat));
      } catch (error) {
        // An account that can't start a session is a reason, not a crash.
        return {
          refusal: refusal ?? (error instanceof Error ? error.message : String(error)),
          notes,
        };
      }
      return { refusal, notes };
    },

    takeoverOf(conversationId) {
      const chat = chatOf(conversationId);
      if (stateOf(chat) !== ConversationState.TakenOver) return null;
      const record = readTakeoverRecord(takeoverFolderOf(deps.dataDir, chat.conversationId));
      const fallback: TakeoverRecord = {
        since: deps.now().toISOString(),
        app: deps.app(),
        tempDirs: [],
      };
      let notes: string[] = [];
      try {
        notes = notesFor(chat);
      } catch {
        // An account that can't start a session has no notes to show; the banner still reads.
      }
      return dto(record ?? fallback, notes, null);
    },

    serialized: (chatId, job) => run(chatId, () => job()),

    ended(chatId) {
      const chat = getChat(state.db, chatId);
      folderHold.handBack(chat.projectId, chatId, () => undefined);
      release(chat);
    },

    recover() {
      const root = join(deps.dataDir, TAKEOVERS);
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        return;
      }
      for (const name of names) {
        const id = ConversationId.safeParse(name);
        if (!id.success) continue;
        const chat = chatOfConversation(state.db, id.data);
        const kept =
          chat !== null &&
          chat.archivedAt === null &&
          getConversation(state.db, id.data).state === ConversationState.TakenOver;
        if (!kept) removeTakeoverFolder(deps.dataDir, id.data);
      }
    },

    async stop() {
      stopping.abort();
      await Promise.all([...chains.values()]);
    },
  };
}
