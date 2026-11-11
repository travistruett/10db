import type { z } from 'zod';
import { systemClock } from '../clock';
import { CODEX_CLIENT_INFO } from './codex-account-read';
import type { CodexAdapterOptions } from './codex-adapter';
import type { CodexHome } from './codex-home';
import { InitializeResponse, MODEL_ITEMS, ThreadTurnsPage } from './codex-protocol';
import { CodexRpcError, createCodexRpc, spawnAppServer } from './codex-rpc';
import { ConversationUnreadError, type ConversationReadSpec } from './types';

// Workbench spec §12. A builder message pushed to a Codex thread and never seen taken is looked for
// in the thread itself before the thread is resumed: every message goes under a client uuid, which
// the thread records on the user message a turn takes it in. The read runs no turn and loads no
// thread to run one, reads the newest turns first, and stops as soon as it knows.

/** How long the whole read may take before it is given up on. */
export const THREAD_READ_MS = 60_000;

/** How many turns one page of the read asks for. */
export const TURNS_PER_PAGE = 20;

/** How many pages the read asks for before it gives up without knowing. */
export const THREAD_READ_PAGES = 10;

/**
 * What Codex answers for a thread no user message has reached: it holds nothing, for certain. A
 * thread that is not loaded in the reading process is "not loaded" instead, which proves nothing.
 */
const NOTHING_SENT_YET = /is not materialized yet; .*before first user message/;

export interface ThreadReadDeps extends CodexAdapterOptions {
  /** The home for an account's `CODEX_HOME`. */
  readonly homes: (path: string) => CodexHome;
}

type Turn = z.infer<typeof ThreadTurnsPage>['data'][number];

/**
 * The client uuids a turn took, on the evidence a live session reads (`mapCodexNotification`): a user
 * message is taken once a model item follows it in the turn, or the turn completed.
 */
function takenIn(turn: Turn): string[] {
  const taken: string[] = [];
  let recorded: string[] = [];
  for (const item of turn.items) {
    if (item.type === 'userMessage' && typeof item.clientId === 'string')
      recorded.push(item.clientId);
    else if (MODEL_ITEMS.has(item.type)) {
      taken.push(...recorded);
      recorded = [];
    }
  }
  return turn.status === 'completed' ? [...taken, ...recorded] : taken;
}

/** The read could not finish: it went unanswered, ran past its budget, or was stopped. */
class ReadEnded extends Error {
  override readonly name = 'ReadEnded';
}

/**
 * Which of `spec.wanted` the thread's turns took, newest turn first, read a page at a time with
 * `thread/turns/list`. It stops once every wanted uuid is found or a turn that ended before
 * `spec.since` is passed. Rejects with a `ConversationUnreadError` that names the thread and how the
 * read failed, never what Codex printed; the child is always closed.
 */
export async function readThreadClientUuids(
  spec: ConversationReadSpec,
  deps: ThreadReadDeps,
): Promise<string[]> {
  const unread = (how: string): ConversationUnreadError =>
    new ConversationUnreadError(
      `Codex could not read back thread ${spec.providerSessionId}: ${how}`,
    );
  const codexHome = spec.env['CODEX_HOME'];
  if (codexHome === undefined || codexHome === '') throw unread('the account has no CODEX_HOME');
  const home = deps.homes(codexHome);
  try {
    // As a session's start does: the checkout is pinned untrusted before the process starts.
    await home.prepare(spec.cwd);
  } catch {
    throw unread('its Codex home could not be prepared');
  }
  const clock = deps.clock ?? systemClock;
  const rpc = createCodexRpc(
    (deps.spawn ?? spawnAppServer)(deps.codexPath, { ...spec.env, HOME: home.emptyHome }),
    deps.logger,
  );
  const wanted = new Set(spec.wanted);
  const since = Date.parse(spec.since);
  const readAll = async (): Promise<string[]> => {
    await rpc.call('initialize', { clientInfo: CODEX_CLIENT_INFO }, InitializeResponse);
    rpc.notify('initialized');
    const found: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < THREAD_READ_PAGES; pages += 1) {
      let page: z.infer<typeof ThreadTurnsPage>;
      try {
        page = await rpc.call(
          'thread/turns/list',
          {
            threadId: spec.providerSessionId,
            itemsView: 'full',
            sortDirection: 'desc',
            limit: TURNS_PER_PAGE,
            cursor,
          },
          ThreadTurnsPage,
        );
      } catch (error) {
        if (error instanceof CodexRpcError && NOTHING_SENT_YET.test(error.message)) return [];
        throw error;
      }
      for (const turn of page.data) {
        for (const uuid of takenIn(turn))
          if (wanted.has(uuid) && !found.includes(uuid)) found.push(uuid);
        if (found.length === wanted.size) return found;
        const ended = turn.completedAt ?? null;
        if (ended !== null && ended * 1_000 < since) return found;
      }
      cursor = page.nextCursor ?? null;
      if (cursor === null) return found;
    }
    throw new ReadEnded(`more than ${String(THREAD_READ_PAGES * TURNS_PER_PAGE)} turns to read`);
  };
  let timer: { cancel(): void } = { cancel: () => undefined };
  let onAbort: () => void = () => undefined;
  const ended = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      reject(new ReadEnded(`no answer within ${String(THREAD_READ_MS / 1_000)} s`));
    }, THREAD_READ_MS);
    onAbort = () => {
      reject(new ReadEnded('the read was stopped'));
    };
    if (spec.signal?.aborted === true) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });
  });
  const reading = readAll();
  try {
    return await Promise.race([reading, ended]);
  } catch (error) {
    if (error instanceof ReadEnded) throw unread(error.message);
    if (error instanceof CodexRpcError) throw unread('an error from Codex');
    throw error;
  } finally {
    timer.cancel();
    spec.signal?.removeEventListener('abort', onAbort);
    rpc.close();
    // Whichever lost the race must not become an unhandled rejection.
    reading.catch(() => undefined);
    ended.catch(() => undefined);
  }
}
