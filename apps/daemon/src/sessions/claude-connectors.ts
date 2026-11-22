import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AccountId } from '@10db/contracts';
import { systemClock, type Clock } from '../clock';
import { AUTOUPDATE_OFF, connectorProbeEnv } from '../environment';
import type { Logger } from '../log';
import { createChannel } from './channel';
import type { QueryFn } from './claude-session';
import { mcpToolPrefix } from './mcp-tool-names';

/** How long a probe waits for the connectors to load before it answers with what it has. */
export const CONNECTOR_PROBE_MS = 10_000;
/** How often a probe reads the server list. */
export const CONNECTOR_POLL_MS = 500;
/** How long a session waits for the connectors before it starts without them and says so. */
export const CONNECTOR_WAIT_MS = 12_000;
/** How long an answer, connectors or none, is kept. */
export const CONNECTOR_TTL_MS = 600_000;
/** How long a failed probe is kept before the next session tries again. */
export const CONNECTOR_RETRY_MS = 60_000;

/** One claude.ai connector as Claude Code reports it: the name its tools take and the proxy to reach it. */
export interface ClaudeConnector {
  readonly name: string;
  readonly url: string;
  readonly id: string;
}

const ProxyConfig = z.looseObject({
  type: z.literal('claudeai-proxy'),
  url: z.url({ protocol: /^https$/ }),
  id: z.string().min(1),
});
const StatusEntry = z.looseObject({
  name: z.string(),
  status: z.string(),
  scope: z.string().optional(),
  config: z.unknown().optional(),
});

interface ReadStatus {
  readonly connectors: ClaudeConnector[];
  /** Any claudeai entry still starting: its siblings may not all be listed yet. */
  readonly pending: boolean;
}

/** The probe's server list read at the boundary; null when it holds anything but claude.ai entries. */
function readStatus(status: unknown): ReadStatus | null {
  const entries = z.array(StatusEntry).safeParse(status);
  if (!entries.success) return null;
  const connectors: ClaudeConnector[] = [];
  let pending = false;
  for (const entry of entries.data) {
    // `dynamic` is a server set over the control channel, never one a file declares.
    if (entry.scope === 'dynamic') continue;
    if (entry.scope !== 'claudeai') return null;
    if (entry.status === 'pending') pending = true;
    const config = ProxyConfig.safeParse(entry.config);
    if (config.success)
      connectors.push({ name: entry.name, url: config.data.url, id: config.data.id });
  }
  return { connectors, pending };
}

/** The connectors a session can take: one whose tool prefix a configured server already holds is left out. */
export function connectorsForSession(
  connectors: readonly ClaudeConnector[],
  takenNames: readonly string[],
): ClaudeConnector[] {
  const taken = new Set(takenNames.map(mcpToolPrefix));
  return connectors.filter((connector) => !taken.has(mcpToolPrefix(connector.name)));
}

export interface ConnectorDirectory {
  /**
   * The connectors of the plan account that `env` (its session environment) launches: `[]` when it has none,
   * null when they could not be read.
   */
  list(
    accountId: AccountId,
    env: Readonly<Record<string, string>>,
  ): Promise<readonly ClaudeConnector[] | null>;
  /**
   * The connectors the last probe of this account read, without starting one: undefined when none ran or the
   * answer has expired, null when the last probe failed.
   */
  peek(accountId: AccountId): readonly ClaudeConnector[] | null | undefined;
  /** The MCP config that last refused this account's probe, or null when none did. */
  refusedPath(accountId: AccountId): string | null;
  /** Closes a probe in flight and empties the probe folder. */
  stop(): Promise<void>;
}

/** Where the connector probe keeps its scratch folders under the data directory. */
export const connectorProbeRoot = (dataDir: string): string => join(dataDir, 'connector-probe');

/** Where Claude Code reads the servers an administrator manages on macOS. */
const MANAGED_MCP_PATH = '/Library/Application Support/ClaudeCode/managed-mcp.json';

/** The probe folder can't be used: it is a link, or a folder above it holds MCP servers a start would run. */
export class ConnectorProbeRefusedError extends Error {
  override readonly name = 'ConnectorProbeRefusedError';
  /** The MCP config that stopped the probe, or null when the folder was refused for another reason. */
  readonly configPath: string | null;
  constructor(message: string, configPath: string | null = null) {
    super(message);
    this.configPath = configPath;
  }
}

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** Refuses a link at `probeRoot`: what a sweep or a probe does there lands wherever the link points. */
async function refuseLink(probeRoot: string): Promise<void> {
  try {
    if ((await lstat(probeRoot)).isSymbolicLink())
      throw new ConnectorProbeRefusedError('The connector probe folder is a link.');
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

/**
 * Makes `probeRoot` a folder only the builder can enter. Refuses a `.mcp.json` in it or any folder above it,
 * and the managed file: a non-strict start reads those and would run their servers outside any sandbox
 * before the list is read.
 */
async function prepareProbeRoot(probeRoot: string, managedMcpPath: string): Promise<void> {
  await refuseLink(probeRoot);
  await mkdir(probeRoot, { recursive: true, mode: 0o700 });
  // `mkdir` leaves a folder that already exists as it was.
  await chmod(probeRoot, 0o700);
  for (let dir = probeRoot; ; dir = dirname(dir)) {
    if (await exists(join(dir, '.mcp.json')))
      throw new ConnectorProbeRefusedError(
        'A folder above the connector probe holds MCP servers.',
        join(dir, '.mcp.json'),
      );
    if (dirname(dir) === dir) break;
  }
  if (await exists(managedMcpPath))
    throw new ConnectorProbeRefusedError(
      'Managed MCP servers are set on this Mac.',
      managedMcpPath,
    );
}

/** Empties `probeRoot`, which a probe that was cut off may have left folders in; a missing folder is already empty. */
export async function sweepConnectorProbeRoot(probeRoot: string): Promise<void> {
  await refuseLink(probeRoot);
  let names: string[];
  try {
    names = await readdir(probeRoot);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) await rm(join(probeRoot, name), { recursive: true, force: true });
}

interface Cached {
  readonly until: number;
  readonly connectors: readonly ClaudeConnector[] | null;
  /** The MCP config that refused the probe, when one did. */
  readonly refusedPath: string | null;
}

/**
 * Reads each plan account's claude.ai connectors with a short Claude Code start of its own: no prompt, no
 * settings file, a fresh empty config folder and a scratch cwd, non-strict because a strict start lists no
 * connector. It keeps the answer for a while and shares one probe among concurrent callers. Nothing else
 * loads: a list holding another scope is refused, and the folders are removed whatever happens.
 */
export function createConnectorDirectory(deps: {
  readonly query: QueryFn;
  readonly claudePath: string;
  readonly probeRoot: string;
  /** Claude Code's managed MCP file; a probe never starts where it exists. Tests pass a path of their own. */
  readonly managedMcpPath?: string;
  readonly clock?: Clock;
  readonly logger: Logger;
}): ConnectorDirectory {
  const clock = deps.clock ?? systemClock;
  const cache = new Map<AccountId, Cached>();
  const inFlight = new Map<AccountId, Promise<readonly ClaudeConnector[] | null>>();
  const closers = new Set<() => void>();
  const state = { stopped: false };
  const isStopped = (): boolean => state.stopped;

  const nowMs = (): number => clock.now().getTime();

  async function probe(env: Readonly<Record<string, string>>): Promise<ClaudeConnector[] | null> {
    await prepareProbeRoot(deps.probeRoot, deps.managedMcpPath ?? MANAGED_MCP_PATH);
    const base = await mkdtemp(join(deps.probeRoot, 'probe-'));
    const cwd = join(base, 'cwd');
    const config = join(base, 'config');
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(config, { mode: 0o700 });
    const input = createChannel<SDKUserMessage>();
    const abortController = new AbortController();
    let expire: () => void = () => undefined;
    const expired = new Promise<'expired'>((resolve) => {
      expire = () => {
        resolve('expired');
      };
    });
    const deadline = clock.setTimeout(expire, CONNECTOR_PROBE_MS);
    let close: () => void = () => undefined;
    const closed = new Promise<'expired'>((resolve) => {
      close = () => {
        resolve('expired');
      };
    });
    closers.add(close);
    let q: ReturnType<QueryFn> | null = null;
    try {
      q = deps.query({
        prompt: input,
        options: {
          cwd,
          env: { ...connectorProbeEnv(env, config), ...AUTOUPDATE_OFF },
          pathToClaudeCodeExecutable: deps.claudePath,
          settingSources: [],
          strictMcpConfig: false,
          permissionMode: 'default',
          canUseTool: () =>
            Promise.resolve({ behavior: 'deny', message: 'A connector probe runs no tools.' }),
          abortController,
        },
      });
      let answered = false;
      let last: ClaudeConnector[] = [];
      for (;;) {
        if (isStopped()) return null;
        const outcome = await Promise.race([
          q.mcpServerStatus().then(
            (status) => ({ status }),
            () => 'threw' as const,
          ),
          expired,
          closed,
        ]);
        if (outcome === 'threw') return null;
        if (outcome === 'expired') return answered ? last : null;
        const read = readStatus(outcome.status);
        if (read === null) {
          deps.logger.warn(
            { entries: Array.isArray(outcome.status) ? outcome.status.length : 0 },
            'the connector probe listed servers that are not claude.ai connectors; none are used',
          );
          return null;
        }
        answered = true;
        last = read.connectors;
        if (last.length > 0 && !read.pending) return last;
        const waited = await Promise.race([
          new Promise<'tick'>((resolve) => {
            const timer = clock.setTimeout(() => {
              resolve('tick');
            }, CONNECTOR_POLL_MS);
            void Promise.race([expired, closed]).then(() => {
              timer.cancel();
            });
          }),
          expired,
          closed,
        ]);
        if (waited === 'expired') return isStopped() ? null : last;
      }
    } catch {
      return null;
    } finally {
      deadline.cancel();
      closers.delete(close);
      input.end();
      abortController.abort();
      try {
        q?.close();
      } catch {
        // The process may already be gone; the folders below are removed either way.
      }
      await rm(base, { recursive: true, force: true });
    }
  }

  return {
    list(accountId, env) {
      if (state.stopped) return Promise.resolve(null);
      const cached = cache.get(accountId);
      if (cached !== undefined && cached.until > nowMs()) return Promise.resolve(cached.connectors);
      const running = inFlight.get(accountId);
      if (running !== undefined) return running;
      let refusedPath: string | null = null;
      const started = probe(env)
        .catch((error: unknown): null => {
          if (error instanceof ConnectorProbeRefusedError) {
            refusedPath = error.configPath;
            deps.logger.warn({}, 'the connector probe was refused: it would start MCP servers');
          }
          return null;
        })
        .then((connectors) => {
          if (!state.stopped)
            cache.set(accountId, {
              until: nowMs() + (connectors === null ? CONNECTOR_RETRY_MS : CONNECTOR_TTL_MS),
              connectors,
              refusedPath,
            });
          deps.logger.info(
            { connectors: connectors === null ? 'failed' : connectors.length },
            'claude.ai connectors read',
          );
          return connectors;
        })
        .finally(() => {
          inFlight.delete(accountId);
        });
      inFlight.set(accountId, started);
      return started;
    },
    peek(accountId) {
      const cached = cache.get(accountId);
      return cached !== undefined && cached.until > nowMs() ? cached.connectors : undefined;
    },
    refusedPath(accountId) {
      return cache.get(accountId)?.refusedPath ?? null;
    },
    async stop() {
      state.stopped = true;
      for (const close of closers) close();
      await Promise.allSettled([...inFlight.values()]);
      await sweepConnectorProbeRoot(deps.probeRoot).catch(() => undefined);
    },
  };
}
