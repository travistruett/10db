import {
  ConflictError,
  FolderAsker,
  FolderHolderKind,
  PassWhenBusy,
  type ChatId,
  type ProjectId,
} from '@10db/contracts';
import { FolderWaitCancelledError, holderWords, type FolderHold } from '../folder-hold';
import type { Logger } from '../log';
import type { PendingOpens } from './pending-open';

/**
 * The longest an open waits for the chats' turns it stopped: a turn's stop grace, the jobs' own deadline
 * and a margin. Past it the open refuses, and the chats' queued messages run.
 */
export const STOPPED_TURNS_DEADLINE_MS = 45_000;

export interface OpenWhenBusyDeps {
  readonly folderHold: Pick<FolderHold, 'blockers'>;
  readonly pendingOpens: PendingOpens;
  /** Stops a chat's turn and holds its starts until the returned release runs. */
  readonly stopChatForOpen: (chatId: ChatId) => Promise<() => void>;
  readonly logger: Logger;
  /** Whether 10db is draining for an update: nothing then waits to open, as the drain would cancel it. */
  readonly draining: () => boolean;
  /** Tells the builder, in Activity, that a pass they were waiting for did not open. */
  readonly notify: (projectId: ProjectId, title: string, body: string) => void;
}

/** What the open is for, in the words a refusal and the pending open use. */
/** Refuses a wait to open while 10db drains for an update, which would cancel it. */
export function refuseWaitWhileDraining(deps: Pick<OpenWhenBusyDeps, 'draining'>): void {
  if (deps.draining())
    throw new ConflictError(
      "10db is about to update, so a pass can't wait to open; try again after it",
    );
}

export interface OpenRequest<T> {
  readonly projectId: ProjectId;
  /** The pass's name. */
  readonly name: string;
  /** The chat whose Do It asks, when one does. */
  readonly chatId: ChatId | null;
  readonly whenBusy: PassWhenBusy | undefined;
  /** Throws what refuses the open whatever the folder does; run before a request is answered as waiting. */
  readonly check?: () => void;
  /** Opens the pass; with `wait`, it waits for chats' turns to end until the signal aborts. */
  readonly open: (wait?: { readonly signal: AbortSignal }) => Promise<T>;
}

/** What a request answers when its open waits for chats' turns instead of opening. */
export interface OpenPending {
  readonly pending: true;
}

/**
 * Opens a pass, taking `whenBusy` into account when chats' turns are all that hold Your folder. Without
 * it, or when anything else holds the folder, the open is made as it is and refuses with the holders
 * named. `stop_turns` stops each holding chat and opens once the folder is free; `wait` records the open
 * as pending and answers at once, opening when the last turn ends. Refused while another open waits.
 */
export async function openWhenBusy<T>(
  deps: OpenWhenBusyDeps,
  request: OpenRequest<T>,
): Promise<T | OpenPending> {
  const { projectId, whenBusy } = request;
  deps.pendingOpens.refuseWhilePending(projectId);
  const blockers = deps.folderHold.blockers(projectId, { kind: FolderAsker.GitWork });
  const allChats = blockers.flatMap((b) =>
    b.holder.kind === FolderHolderKind.ChatTurn && b.holder.chatId !== null
      ? [b.holder.chatId]
      : [],
  );
  const onlyChats = blockers.length > 0 && allChats.length === blockers.length;
  // The requesting chat's own turn is already stopped by the caller, so it is neither stopped again nor waited on.
  const chats = allChats.filter((id) => id !== request.chatId);
  if (whenBusy === undefined || !onlyChats || chats.length === 0) return request.open();

  if (whenBusy === PassWhenBusy.Wait) {
    refuseWaitWhileDraining(deps);
    request.check?.();
    const signal = deps.pendingOpens.begin(projectId, {
      name: request.name,
      waitsFor: blockers
        .filter((b) => b.holder.chatId !== request.chatId)
        .map((b) => holderWords(b.holder))
        .join(' and '),
      chatId: request.chatId,
    });
    request.open({ signal }).then(
      () => {
        deps.pendingOpens.end(projectId, signal);
      },
      (error: unknown) => {
        deps.pendingOpens.end(projectId, signal);
        // A cancelled wait is the builder's or an update's doing; any other refusal has no one waiting on it.
        if (!(error instanceof FolderWaitCancelledError)) {
          const why = error instanceof Error ? error.message : String(error);
          deps.logger.warn({ projectId, err: why }, 'a pass waiting to open was refused');
          deps.notify(projectId, `Pass ‘${request.name}’ did not open`, why);
        }
      },
    );
    return { pending: true };
  }

  const releases: (() => void)[] = [];
  try {
    for (const chatId of chats) releases.push(await deps.stopChatForOpen(chatId));
    try {
      return await request.open({ signal: AbortSignal.timeout(STOPPED_TURNS_DEADLINE_MS) });
    } catch (error) {
      if (error instanceof FolderWaitCancelledError)
        throw new ConflictError("The chat's turn didn't stop in time");
      throw error;
    }
  } finally {
    for (const release of releases) release();
  }
}
