import { randomBytes } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { systemClock } from '../clock';
import { checkAccount, modelMatches } from './account-check';
import type { CodexAdapterOptions } from './codex-adapter';
import { CODEX_CLIENT_INFO, readSeenAccount } from './codex-account-read';
import { openGuardSocket, type GuardSocket } from './codex-guard';
import {
  codexChildHome,
  codexHomeProviderOf,
  GUARD_HOOK_EVENT,
  type CodexHome,
} from './codex-home';
import { LANE_PROFILE } from './codex-lane-config';
import { readOnlyPermissions } from './codex-lane-permissions';
import {
  HooksListResponse,
  InitializeResponse,
  ItemCompleted,
  ItemStarted,
  ThreadResponse,
  TurnCompleted,
  TurnStartResponse,
} from './codex-protocol';
import { createCodexRpc, spawnAppServer, type CodexRpc } from './codex-rpc';
import { guardSocketPath } from './codex-session';
import { stopLoginProcess } from './login-stop';
import { CompletionError, type CompletionSpec } from './types';

/**
 * What a tool-locked turn needs of the Codex adapter's own options, so the two never drift: the binary,
 * the logger, the clock, a spawn for tests and the socket directory, with the account homes.
 */
export type CodexCompleteOptions = Pick<
  CodexAdapterOptions,
  'codexPath' | 'logger' | 'spawn' | 'clock' | 'socketDir'
> & {
  readonly homes: (path: string, provider: ReturnType<typeof codexHomeProviderOf>) => CodexHome;
};

/** The same wait as Claude's one-shot question. */
const DEFAULT_TIMEOUT_MS = 2 * 60_000;
/** How long one call of the start (initialize, account reads, thread) may take. */
const CALL_MS = 60_000;
const TRUSTED = 'trusted';
const SOCKET_DIR_MODE = 0o700;
const TOOL_LOCK_REASON = 'This turn has no tools.';
const INSTRUCTIONS = 'Answer only from the prompt. You have no tools.';

/**
 * The thread items a tool-locked turn may carry: what the model writes and thinks, and the echo of the
 * prompt. Any other item type is a tool, or something that may run one, so it ends the turn.
 */
const SAFE_ITEMS: ReadonlySet<string> = new Set(['agentMessage', 'reasoning', 'userMessage']);

const AgentMessage = z.looseObject({ type: z.literal('agentMessage'), text: z.string() });

const noWait = (): { cancel(): void } => ({ cancel: () => undefined });

/**
 * One question to a Codex model with no tools, on an ephemeral `codex app-server` thread in the caller's
 * empty folder. The lock has two layers: the guard hook, on a socket of its own that refuses every call,
 * and the turn's item stream, which ends the turn and the process on the first item that is not a message
 * or reasoning, because some Codex tools run where the hook can't see them. A tool the turn started,
 * even a refused one, fails the question. Always ends the process; rejects with a `CompletionError`.
 */
export async function completeWithCodex(
  spec: CompletionSpec,
  opts: CodexCompleteOptions,
): Promise<string> {
  const clock = opts.clock ?? systemClock;
  const log = opts.logger;
  let codexHome: string;
  let emptyHome: string;
  try {
    const dirs = codexChildHome(spec.env);
    codexHome = dirs.codexHome;
    emptyHome = dirs.home;
  } catch {
    throw new CompletionError(
      'The account has no Codex folder, so Codex would use the shared one.',
    );
  }
  const home = opts.homes(codexHome, codexHomeProviderOf(spec.account.kind));

  let ending: (error: CompletionError) => void = () => undefined;
  const over = new Promise<never>((_, reject) => {
    ending = reject;
  });
  over.catch(() => undefined);
  const fail = (message: string): void => {
    ending(new CompletionError(message));
  };
  const lock = { toolSeen: false };
  let threadId: string | null = null;
  const toolRun = (what: string, turnId?: string): void => {
    lock.toolSeen = true;
    // The turn is told to stop before the process is; the process ending is what makes it certain.
    if (rpc !== null && threadId !== null && turnId !== undefined)
      rpc.call('turn/interrupt', { threadId, turnId }, z.looseObject({})).catch(() => undefined);
    fail(`The Codex turn started a tool (${what}), so its answer was not used.`);
  };

  let guard: GuardSocket | null = null;
  let rpc: CodexRpc | null = null;
  let timer = noWait();
  const onAbort = (): void => {
    fail('The question was stopped.');
  };
  try {
    try {
      await home.prepare(spec.cwd);
    } catch {
      throw new CompletionError('The Codex folder of the account could not be prepared.');
    }
    const socketDir = opts.socketDir ?? join(homedir(), '.10db', 'run');
    try {
      await mkdir(socketDir, { recursive: true, mode: SOCKET_DIR_MODE });
      guard = await openGuardSocket(
        guardSocketPath(socketDir, randomBytes(8).toString('hex')),
        () => {
          // The hook was asked about a call: a tool was attempted, whatever the answer.
          toolRun('the guard hook was asked');
          return Promise.resolve({ allow: false, reason: TOOL_LOCK_REASON, interrupt: true });
        },
        (code) => {
          log.error({ code }, 'the guard socket of a one-shot question reported an error');
        },
      );
    } catch {
      throw new CompletionError(
        'The guard socket could not be opened, so no tool could be locked.',
      );
    }

    const child = (opts.spawn ?? spawnAppServer)(opts.codexPath, {
      ...spec.env,
      HOME: emptyHome,
      TENDB_GUARD_SOCKET: guard.path,
      TENDB_GUARD_MAX_SECONDS: '30',
    });
    const proc = createCodexRpc(child, log);
    rpc = proc;
    void proc.exited.then(({ code }) => {
      fail(`Codex exited (${String(code)}) before it answered.`);
    });

    timer = clock.setTimeout(() => {
      fail('Codex did not answer in time.');
    }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (spec.signal?.aborted === true) onAbort();
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    let answer = '';
    let finished: (text: string) => void = () => undefined;
    const completed = new Promise<string>((resolve) => {
      finished = resolve;
    });
    proc.onNotification((n) => {
      if (n.method === 'item/started' || n.method === 'item/completed') {
        const shape = n.method === 'item/started' ? ItemStarted : ItemCompleted;
        const parsed = shape.safeParse(n.params);
        if (!parsed.success) {
          // An item whose shape is unknown can't be told from a tool.
          toolRun('an item of an unknown shape');
          return;
        }
        if (parsed.data.threadId !== threadId) return;
        const { item } = parsed.data;
        if (!SAFE_ITEMS.has(item.type)) {
          toolRun(item.type, parsed.data.turnId);
          return;
        }
        const message = AgentMessage.safeParse(item);
        if (n.method === 'item/completed' && message.success) answer = message.data.text;
        return;
      }
      if (n.method === 'turn/completed') {
        const parsed = TurnCompleted.safeParse(n.params);
        if (!parsed.success || parsed.data.threadId !== threadId) return;
        if (parsed.data.turn.status === 'completed') finished(answer);
        else fail('The Codex turn did not complete.');
      }
    });

    const ask = async <T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> => {
      let wait = noWait();
      const deadline = new Promise<never>((_, reject) => {
        wait = clock.setTimeout(() => {
          reject(new CompletionError(`Codex did not answer ${method} in time.`));
        }, CALL_MS);
      });
      try {
        return await Promise.race([proc.call(method, params, schema), deadline, over]);
      } finally {
        wait.cancel();
        deadline.catch(() => undefined);
      }
    };

    await ask('initialize', { clientInfo: CODEX_CLIENT_INFO }, InitializeResponse);
    proc.notify('initialized');
    const refusal = checkAccount(
      spec.account,
      await readSeenAccount((method, params, schema) => ask(method, params, schema), false).catch(
        (error: unknown) => {
          if (error instanceof CompletionError) throw error;
          throw new CompletionError('Codex could not report the account.');
        },
      ),
    );
    if (refusal) throw new CompletionError(refusal.message);

    // The hook only locks anything once Codex trusts it.
    const ownConfig = await realpath(join(home.path, 'config.toml'));
    const readHook = async () =>
      (await ask('hooks/list', { cwds: [spec.cwd] }, HooksListResponse)).data
        .flatMap((entry) => entry.hooks)
        .find((h) => h.eventName === GUARD_HOOK_EVENT && h.sourcePath === ownConfig);
    let hook = await readHook();
    if (hook?.enabled === true && hook.trustStatus !== TRUSTED) {
      await home.trustGuardHook(hook.key, hook.currentHash);
      hook = await readHook();
    }
    if (hook?.enabled !== true || hook.trustStatus !== TRUSTED)
      throw new CompletionError('Codex does not trust the guard hook, so no tool could be locked.');

    const started = await ask(
      'thread/start',
      {
        cwd: spec.cwd,
        model: spec.model,
        ephemeral: true,
        approvalPolicy: 'never',
        developerInstructions: INSTRUCTIONS,
        config: {
          permissions: readOnlyPermissions(spec.cwd, []),
          web_search: 'disabled',
          mcp_servers: {},
          shell_environment_policy: { inherit: 'none' },
        },
      },
      ThreadResponse,
    );
    if (started.activePermissionProfile?.id !== LANE_PROFILE)
      throw new CompletionError(
        'Codex runs the thread under a permission profile other than the lane.',
      );
    if (!modelMatches(spec.model, started.model))
      throw new CompletionError(`10db asked for ${spec.model} but Codex runs ${started.model}.`);
    threadId = started.thread.id;

    await ask(
      'turn/start',
      {
        threadId,
        input: [{ type: 'text', text: spec.prompt, text_elements: [] }],
        approvalPolicy: 'never',
        model: spec.model,
        effort: spec.effort,
      },
      TurnStartResponse,
    );
    const text = (await Promise.race([completed, over])).trim();
    if (lock.toolSeen) throw new CompletionError('The Codex turn started a tool.');
    if (text === '') throw new CompletionError('Codex gave no answer.');
    return text;
  } catch (error) {
    if (error instanceof CompletionError) throw error;
    log.warn(
      { errName: error instanceof Error ? error.name : 'unknown' },
      'a codex question failed',
    );
    throw new CompletionError('Codex could not answer.');
  } finally {
    timer.cancel();
    spec.signal?.removeEventListener('abort', onAbort);
    if (rpc !== null) {
      const proc = rpc;
      await stopLoginProcess(
        {
          kill: (signal) => {
            proc.close(signal);
          },
          exited: proc.exited,
        },
        clock,
      );
    }
    await guard?.close().catch(() => undefined);
  }
}
