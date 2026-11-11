import type { z } from 'zod';
import { systemClock } from '../clock';
import { CODEX_CLIENT_INFO } from './codex-account-read';
import type { CodexAdapterOptions } from './codex-adapter';
import type { CodexHome } from './codex-home';
import { InitializeResponse, ThreadTurnsPage } from './codex-protocol';
import { CodexRpcError, createCodexRpc, spawnAppServer } from './codex-rpc';
import { ConversationUnreadError, type ConversationReadSpec } from './types';

// Workbench spec §12. After a restart, a builder message pushed to a Codex thread and never seen
// taken is looked for in the thread itself: every message goes under a client uuid, which the thread
// records on the user message a turn takes it in. The read runs no turn and loads no thread to run one.

/** How long the whole read may take before it is given up on. */
export const THREAD_READ_MS = 60_000;

export interface ThreadReadDeps extends CodexAdapterOptions {
  /** The home for an account's `CODEX_HOME`. */
  readonly homes: (path: string) => CodexHome;
}

/** The read went unanswered for `THREAD_READ_MS`. */
class ReadTimeout extends Error {
  override readonly name = 'ReadTimeout';
}

/**
 * The client uuid of every user message the thread holds, newest turn first, read page by page with
 * `thread/turns/list`. Rejects with a `ConversationUnreadError` that names the thread and how the
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
  const readAll = async (): Promise<string[]> => {
    await rpc.call('initialize', { clientInfo: CODEX_CLIENT_INFO }, InitializeResponse);
    rpc.notify('initialized');
    const uuids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: z.infer<typeof ThreadTurnsPage> = await rpc.call(
        'thread/turns/list',
        { threadId: spec.providerSessionId, itemsView: 'full', cursor },
        ThreadTurnsPage,
      );
      for (const turn of page.data)
        for (const item of turn.items)
          if (item.type === 'userMessage' && typeof item.clientId === 'string')
            uuids.push(item.clientId);
      cursor = page.nextCursor ?? null;
    } while (cursor !== null);
    return uuids;
  };
  let timer: { cancel(): void } = { cancel: () => undefined };
  const deadline = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      reject(new ReadTimeout());
    }, THREAD_READ_MS);
  });
  const reading = readAll();
  try {
    return await Promise.race([reading, deadline]);
  } catch (error) {
    if (error instanceof ReadTimeout)
      throw unread(`no answer within ${String(THREAD_READ_MS / 1_000)} s`);
    if (error instanceof CodexRpcError) throw unread('an error from Codex');
    throw error;
  } finally {
    timer.cancel();
    rpc.close();
    // Whichever lost the race must not become an unhandled rejection.
    reading.catch(() => undefined);
    deadline.catch(() => undefined);
  }
}
