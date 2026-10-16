import { spawn } from 'node:child_process';
import {
  query as sdkQuery,
  type AccountInfo,
  type Options,
  type Query,
  type SDKSystemMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { Provider } from '@10db/contracts';
import { systemClock, type Clock } from '../clock';
import type { Logger } from '../log';
import { createChannel } from './channel';
import {
  billingMismatch,
  contextEvent,
  mapSdkMessage,
  toHookOutput,
  toPermissionResult,
  toSdkMcpServer,
  userMessage,
} from './claude-mapping';
import { TENDB_MCP_SERVER } from './project-mcp';
import type { SessionAdapter, SessionEvent, SessionHandle, SessionSpec } from './types';

export const CLAUDE_MCP_SERVER = TENDB_MCP_SERVER;
/** How long Claude Code may take to report its account before the prompt is sent. */
const BILLING_PREFLIGHT_MS = 15_000;
const STOP_GRACE_MS = 5_000;
const STDERR_LOG_CHARS = 2_000;
const BILLING_UNVERIFIED =
  'The billing check for this session did not pass, so 10db allows no tools in it.';

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

export interface ClaudeAdapterOptions {
  /** The builder's installed claude, found on the login PATH. */
  readonly claudePath: string;
  /** The injected harness plugin directory. */
  readonly pluginDir: string;
  readonly logger: Logger;
  /** The SDK's query(); tests pass a scripted one. */
  readonly query?: QueryFn;
  /** How long stop() waits for interrupt, then for exit after abort. */
  readonly stopGraceMs?: number;
  /** Times the preflight and the stop grace periods; tests pass a ManualClock. */
  readonly clock?: Clock;
}

interface QueryDeps {
  readonly claudePath: string;
  readonly pluginDir: string;
  readonly abortController: AbortController;
  /** Resolves true once the session's credentials match its billing mode; tools wait for it. */
  readonly billingVerified: Promise<boolean>;
  readonly onSpawn: (pid: number | null) => void;
  readonly onStderr: (chunk: string) => void;
}

/** Spawns claude as our own child, so recovery knows its pid and the log gets its stderr. */
function spawnClaude(
  options: SpawnOptions,
  deps: Pick<QueryDeps, 'onSpawn' | 'onStderr'>,
): SpawnedProcess {
  // The SDK's forwarded signal fires after its graceful stdin-close path, so it is not handed to spawn().
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  deps.onSpawn(child.pid ?? null);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    deps.onStderr(chunk);
  });
  options.signal.addEventListener(
    'abort',
    () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    },
    { once: true },
  );
  return child;
}

export function buildQueryOptions(spec: SessionSpec, deps: QueryDeps): Options {
  return {
    cwd: spec.cwd,
    model: spec.model,
    effort: spec.effort,
    ...(spec.resumeProviderSessionId ? { resume: spec.resumeProviderSessionId } : {}),
    env: { ...spec.env },
    pathToClaudeCodeExecutable: deps.claudePath,
    // Never 'user' or 'local': user hooks and plugins stay out (spec §3), and settings.local.json can switch billing.
    settingSources: ['project'],
    // Claude Code reads no MCP config itself; the repo's .mcp.json arrives through the spec.
    strictMcpConfig: true,
    // Set explicitly: the builder's own autoCompactEnabled: false (global ~/.claude.json) reaches the session despite
    // settingSources. Compaction stays on as the emergency fallback.
    settings: { autoCompactEnabled: true },
    mcpServers: {
      ...Object.fromEntries(
        Object.entries(spec.projectMcpServers).map(([name, server]) => [
          name,
          toSdkMcpServer(server),
        ]),
      ),
      // Last, so 10db's own server always keeps its name.
      [CLAUDE_MCP_SERVER]: {
        type: 'http',
        url: spec.mcp.url,
        headers: { Authorization: `Bearer ${spec.mcp.token}` },
        timeout: spec.mcp.toolTimeoutMs,
        // Deferred behind tool search, the agent might not see write_handoff when it needs it.
        alwaysLoad: true,
      },
    },
    plugins: [{ type: 'local', path: deps.pluginDir }],
    allowedTools: [...spec.allowedTools],
    permissionMode: 'default',
    canUseTool: async (toolName, input, options) => {
      if (!(await deps.billingVerified))
        return { behavior: 'deny', message: BILLING_UNVERIFIED, interrupt: true };
      return toPermissionResult(
        await spec.canUseTool({
          toolName,
          input,
          toolUseId: options.toolUseID,
          signal: options.signal,
        }),
        input,
      );
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hookInput) => {
              if (hookInput.hook_event_name !== 'PreToolUse') return {};
              if (!(await deps.billingVerified))
                return toHookOutput({ decision: 'deny', reason: BILLING_UNVERIFIED });
              return toHookOutput(
                spec.preToolUse({ toolName: hookInput.tool_name, input: hookInput.tool_input }),
              );
            },
          ],
        },
      ],
    },
    abortController: deps.abortController,
    spawnClaudeCodeProcess: (options) => spawnClaude(options, deps),
  };
}

/** Resolves with the value, or undefined after `ms` or on rejection. Never rejects. */
function settleWithin<T>(clock: Clock, promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = clock.setTimeout(() => {
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        timer.cancel();
        resolve(value);
      },
      () => {
        timer.cancel();
        resolve(undefined);
      },
    );
  });
}

type EndReason = Extract<SessionEvent, { type: 'ended' }>['reason'];

function startSession(
  spec: SessionSpec,
  opts: ClaudeAdapterOptions,
  runQuery: QueryFn,
): SessionHandle {
  const graceMs = opts.stopGraceMs ?? STOP_GRACE_MS;
  const clock = opts.clock ?? systemClock;
  const log = opts.logger.child({ sessionId: spec.sessionId, workstreamId: spec.workstreamId });
  const events = createChannel<SessionEvent>();
  const input = createChannel<SDKUserMessage>();
  const abortController = new AbortController();
  const totals = { inputTokens: 0, outputTokens: 0 };
  let account: AccountInfo | undefined;
  // The preflight gates the prompt; billingVerified (preflight plus the init check) gates every tool.
  let resolvePreflight: (ok: boolean) => void = () => undefined;
  const preflightOk = new Promise<boolean>((resolve) => {
    resolvePreflight = resolve;
  });
  let resolveVerified: (ok: boolean) => void = () => undefined;
  const billingVerified = new Promise<boolean>((resolve) => {
    resolveVerified = resolve;
  });
  let pid: number | null = null;
  let started = false;
  let ended = false;
  let stopRequested = false;
  let promptSent = false;
  let limitRejected = false;
  let lastResetsAt: Date | null = null;
  let failure: string | null = null;
  let markFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });

  const emit = (event: SessionEvent): void => {
    if (!ended) events.push(event);
  };
  const end = (reason: EndReason, message: string | null): void => {
    if (ended) return;
    ended = true;
    resolvePreflight(false);
    resolveVerified(false);
    input.end();
    events.push({ type: 'ended', reason, message });
    events.end();
    markFinished();
  };
  const endReason = (): EndReason => {
    if (failure) return 'error';
    if (stopRequested) return 'stopped';
    return limitRejected ? 'rate_limited' : 'completed';
  };

  // The prompt is not pushed yet: it goes in only after the billing preflight passes.
  const q = runQuery({
    prompt: input,
    options: buildQueryOptions(spec, {
      claudePath: opts.claudePath,
      pluginDir: opts.pluginDir,
      abortController,
      billingVerified,
      onSpawn: (p) => {
        pid = p;
      },
      onStderr: (chunk) => {
        log.debug({ stderr: chunk.slice(0, STDERR_LOG_CHARS) }, 'claude stderr');
      },
    }),
  });

  const refuse = (message: string): void => {
    failure = message;
    resolvePreflight(false);
    resolveVerified(false);
    log.error({ reason: message }, 'claude session refused');
    input.end();
    void settleWithin(clock, q.interrupt(), graceMs);
    abortController.abort();
  };
  const fixHint =
    "Check the project's billing mode and any env block in the repo's .claude/settings.json.";

  /**
   * Before the prompt: the account Claude Code loaded must match the project's billing mode. A named
   * function, not an IIFE: TypeScript reads an IIFE as running inline, and would narrow `ended` to false.
   */
  const preflight = async (): Promise<void> => {
    account = await settleWithin(clock, q.accountInfo(), BILLING_PREFLIGHT_MS);
    if (ended) return;
    const mismatch = account
      ? billingMismatch(spec.billingMode, {
          apiKeySource: account.apiKeySource,
          apiProvider: account.apiProvider,
          subscriptionType: account.subscriptionType,
        })
      : `Claude Code reported no account within ${String(BILLING_PREFLIGHT_MS / 1_000)} s`;
    if (mismatch) {
      refuse(`Billing check failed: ${mismatch}. No prompt was sent. ${fixHint}`);
      return;
    }
    if (stopRequested) {
      // Stopped during the preflight: release the event pump, which waits on this before the first init.
      resolvePreflight(false);
      return;
    }
    input.push(userMessage(spec.prompt));
    promptSent = true;
    resolvePreflight(true);
  };
  void preflight();

  /** On the first init: the credentials the CLI actually uses, after the repo's settings were applied. */
  function checkInit(init: SDKSystemMessage): void {
    // Never log email or organization.
    log.info(
      {
        apiKeySource: init.apiKeySource,
        apiProvider: account?.apiProvider,
        subscriptionType: account?.subscriptionType,
        claudeCodeVersion: init.claude_code_version,
        model: init.model,
      },
      'claude session billing',
    );
    // The servers the CLI loaded: 10db's own plus the repo's. Names and status only, never their config.
    log.info(
      { mcpServers: init.mcp_servers.map((s) => ({ name: s.name, status: s.status })) },
      'claude session mcp',
    );
    // init has no plan field, so the preflight's account supplies apiProvider and subscriptionType.
    const mismatch = billingMismatch(spec.billingMode, {
      apiKeySource: init.apiKeySource,
      apiProvider: account?.apiProvider,
      subscriptionType: account?.subscriptionType,
    });
    if (mismatch) {
      refuse(
        `Billing check failed: ${mismatch}. The session stopped at its first turn, before any tool ran; that turn's first request may have been billed this way. ${fixHint}`,
      );
      return;
    }
    resolveVerified(true);
  }

  let mcpStatusLogged = false;
  /**
   * Once, after the first turn: MCP startup doesn't block init, so init often still says `pending` for a
   * server `npx` is downloading. Names and status only; the status's `config` holds header values.
   */
  const logMcpStatus = (): void => {
    if (mcpStatusLogged) return;
    mcpStatusLogged = true;
    q.mcpServerStatus().then(
      (servers) => {
        log.info(
          { mcpServers: servers.map((s) => ({ name: s.name, status: s.status })) },
          'claude session mcp status',
        );
      },
      (error: unknown) => {
        log.debug({ err: String(error) }, 'mcp server status unavailable');
      },
    );
  };

  const readContext = (): void => {
    q.getContextUsage({ detail: 'summary' }).then(
      (usage) => {
        emit(contextEvent(usage));
      },
      (error: unknown) => {
        log.debug({ err: String(error) }, 'context usage unavailable');
      },
    );
  };

  const pump = async (): Promise<void> => {
    try {
      for await (const msg of q) {
        if (failure) continue;
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (started) continue;
          if (!(await preflightOk)) continue;
          checkInit(msg);
          if (failure) continue;
          started = true;
        }
        for (const event of mapSdkMessage(msg, { pid })) {
          if (event.type === 'turn_complete') {
            totals.inputTokens += event.inputTokens;
            totals.outputTokens += event.outputTokens;
            limitRejected = false;
            emit({ ...event, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens });
            logMcpStatus();
          } else if (event.type === 'rate_limit') {
            if (event.status === 'rejected') limitRejected = true;
            if (event.resetsAt) lastResetsAt = event.resetsAt;
            // An assistant rate_limit error carries no reset time: use the latest one a rate_limit_event reported.
            emit(event.resetsAt ? event : { ...event, resetsAt: lastResetsAt });
          } else {
            emit(event);
          }
        }
        if (msg.type === 'assistant') readContext();
      }
      end(endReason(), failure);
    } catch (error) {
      if (failure) end('error', failure);
      else if (stopRequested) end('stopped', null);
      else end('error', error instanceof Error ? error.message : String(error));
    }
  };
  void pump();

  return {
    events,
    send(text) {
      if (ended) return;
      // Never ahead of the prompt: a message sent during the preflight waits for it, and is dropped if it fails.
      if (promptSent) {
        input.push(userMessage(text, 'next'));
        return;
      }
      void preflightOk.then((ok) => {
        if (ok && !ended) input.push(userMessage(text, 'next'));
      });
    },
    async stop() {
      if (ended) return;
      stopRequested = true;
      input.end();
      await settleWithin(clock, q.interrupt(), graceMs);
      const abortTimer = clock.setTimeout(() => {
        abortController.abort();
      }, graceMs);
      const forceTimer = clock.setTimeout(() => {
        end('stopped', 'claude did not exit after it was aborted');
      }, graceMs * 2);
      await finished;
      abortTimer.cancel();
      forceTimer.cancel();
    },
  };
}

/** Runs managed sessions on the builder's installed Claude Code through the Agent SDK (spec §3). */
export function createClaudeAdapter(opts: ClaudeAdapterOptions): SessionAdapter {
  const runQuery: QueryFn = opts.query ?? ((params) => sdkQuery(params));
  return {
    provider: Provider.Claude,
    start: (spec) => startSession(spec, opts, runQuery),
  };
}
