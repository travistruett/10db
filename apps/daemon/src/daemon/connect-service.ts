import { execFile } from 'node:child_process';
import {
  CONNECTABLE_SERVICE_LABELS,
  ConflictError,
  ConnectNext,
  EventType,
  McpSignInChangedData,
  McpSignInState,
  Provider,
  YourMcpServerState,
  YourMcpSource,
  harnessOf,
  type ApproveYourMcpServer,
  type ConnectServiceDto,
  type ConnectableService,
  type ProjectId,
  type StartMcpSignIn,
  type YourMcpServerDto,
  type YourMcpServerKey,
} from '@10db/contracts';
import { getAccountRow, getProject } from '@10db/db';
import { z } from 'zod';
import type { McpSignIns } from '../accounts';
import { AgentState, AgentTool, AUTOUPDATE_OFF, type AgentTools } from '../environment';
import type { EventBus, StateStore } from '../events';

/** One service Connect sets up: the name its server gets and its address. Only its own host is ever approved. */
interface ConnectableEntry {
  readonly name: string;
  readonly url: string;
}

export const CONNECTABLE_SERVICES: Readonly<Record<ConnectableService, ConnectableEntry>> = {
  linear: { name: 'linear', url: 'https://mcp.linear.app/mcp' },
  figma: { name: 'figma', url: 'https://mcp.figma.com/mcp' },
};

const CLI_TIMEOUT_MS = 30_000;
/** Proxy settings that refuse every connection, so a CLI's login discovery fails fast. */
const DEAD_PROXY = {
  HTTPS_PROXY: 'http://127.0.0.1:9',
  HTTP_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '',
} as const;

/** What a child process left: the exit code (-1 when it could not run) and what it printed. */
const CliResult = z.object({ code: z.number().int(), stdout: z.string(), stderr: z.string() });
export type CliResult = z.infer<typeof CliResult>;
export type RunCli = (
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<CliResult>;

export const runCli: RunCli = (file, args, env) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { env: { ...env }, timeout: CLI_TIMEOUT_MS, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolve(
          CliResult.parse({
            code,
            stdout,
            stderr: stderr === '' ? (error?.message ?? '') : stderr,
          }),
        );
      },
    );
  });

const hostOf = (url: string | null): string | null => {
  if (url === null) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * Whether an account can use a server of the builder's from this key's source. Every session gets the approved
 * servers of every source, and Codex signs in any of them; Claude Code's `/mcp` signs in only what its own
 * config holds.
 */
export function harnessReadsServer(harness: Provider, key: YourMcpServerKey): boolean {
  return harness === Provider.Codex || !key.startsWith(`${YourMcpSource.CodexConfig}:`);
}

/** The builder's servers as a project's sessions would see them, with the project's switch for them. */
export interface ProjectMcpServers {
  readonly servers: readonly YourMcpServerDto[];
  /** The server key each name resolves to in a session of the project: the one that session actually loads. */
  readonly loaded: Readonly<Record<string, YourMcpServerKey>>;
  /** The project's effective Your MCP servers switch. */
  readonly on: boolean;
}

export interface ServiceConnector {
  /**
   * Adds the service's server to the project account's agent config when it has none at the service's host,
   * approves it, and signs the account in (Codex) or leaves `/mcp` to the builder (Claude Code). A step that
   * already holds is skipped, so a repeat is safe. Throws ConflictError with the reason when a step can't run,
   * including a server the project's sessions would not load.
   */
  connect(service: ConnectableService, projectId: ProjectId): Promise<ConnectServiceDto>;
  /** Drops a connect still waiting on a sign-in, so its follow-on never runs: the builder turned it off. */
  forget(service: ConnectableService, projectId: ProjectId): void;
}

interface Pending {
  readonly service: ConnectableService;
  readonly projectId: ProjectId;
}

export function createServiceConnector(deps: {
  readonly state: StateStore;
  /** The builder's servers and the Your MCP servers switch, as the project's sessions would read them now. */
  readonly mcp: (projectId: ProjectId) => ProjectMcpServers;
  /** Settings › Trust's Approve. */
  readonly approve: (input: ApproveYourMcpServer) => Promise<unknown>;
  readonly mcpSignIns: Pick<McpSignIns, 'list' | 'start'>;
  readonly bus: Pick<EventBus, 'subscribe'>;
  /** A service's own next step once it works for a project: a Codex account is signed in. */
  readonly whenWorks?: (service: ConnectableService, projectId: ProjectId) => void;
  readonly agents: () => AgentTools | null;
  /** The login environment without billing switches. */
  readonly loginEnv: () => Readonly<Record<string, string>>;
  readonly builderHome: string;
  /** The child process boundary; tests replace it. */
  readonly run?: RunCli;
}): ServiceConnector {
  const run = deps.run ?? runCli;
  /** Connects waiting on a browser sign-in, by account and server; lost with a restart, and the switch stays a click. */
  const pending = new Map<string, Pending[]>();
  deps.bus.subscribe((event) => {
    if (event.type !== EventType.McpSignInChanged) return;
    const changed = McpSignInChangedData.safeParse(event.data);
    if (!changed.success) return;
    const id = `${changed.data.accountId}:${changed.data.key}`;
    if (changed.data.state === McpSignInState.Failed) pending.delete(id);
    if (changed.data.state !== McpSignInState.SignedIn) return;
    for (const waiting of pending.get(id) ?? [])
      deps.whenWorks?.(waiting.service, waiting.projectId);
    pending.delete(id);
  });

  /** The agent's own CLI adds the server to the builder's own config, as the builder would by hand. */
  const add = async (harness: Provider, entry: ConnectableEntry, label: string): Promise<void> => {
    const tool = harness === Provider.Codex ? AgentTool.Codex : AgentTool.Claude;
    const status = deps
      .agents()
      ?.statuses()
      .find((s) => s.tool === tool);
    if (status?.state !== AgentState.Ready || status.path === null)
      throw new ConflictError(
        `${status?.label ?? tool} isn't ready yet, so ${label} can't be added. Try again once it has been checked.`,
      );
    // The builder's own config: the login environment, pointed at their home and at no account's folder.
    const rest = Object.entries(deps.loginEnv()).filter(
      ([name]) => name !== 'CODEX_HOME' && name !== 'CLAUDE_CONFIG_DIR',
    );
    // `codex mcp add --url` starts an OAuth login in the builder's own Codex and opens their browser. Its
    // discovery request goes through a proxy that refuses connections, so the entry is written and the CLI
    // exits at once; the account's own sign-in is the only one 10db starts.
    const noLogin = DEAD_PROXY;
    const env = {
      ...Object.fromEntries(rest),
      ...AUTOUPDATE_OFF,
      ...(harness === Provider.Codex ? noLogin : {}),
      HOME: deps.builderHome,
    };
    const args =
      harness === Provider.Codex
        ? ['mcp', 'add', entry.name, '--url', entry.url]
        : ['mcp', 'add', '--transport', 'http', '--scope', 'user', entry.name, entry.url];
    const result = await run(status.path, args, env);
    if (result.code !== 0) {
      const said =
        (result.stderr === '' ? result.stdout : result.stderr).trim().split('\n')[0] ?? '';
      throw new ConflictError(`${status.label} couldn't add ${label}: ${said.slice(0, 300)}`);
    }
  };

  return {
    forget(service, projectId) {
      for (const [id, waiting] of pending) {
        const left = waiting.filter((p) => p.service !== service || p.projectId !== projectId);
        if (left.length === 0) pending.delete(id);
        else pending.set(id, left);
      }
    },
    async connect(service, projectId) {
      const entry = CONNECTABLE_SERVICES[service];
      const label = CONNECTABLE_SERVICE_LABELS[service];
      const host = hostOf(entry.url);
      const project = getProject(deps.state.db, projectId);
      const account = getAccountRow(deps.state.db, project.accountId);
      const harness = harnessOf(account);
      if (harness === null) throw new ConflictError(`This project's account can't run ${label}.`);

      // A server at the entry's host counts when this account can sign in to it: any source for Codex, Claude
      // Code's own config and plugins for Claude. One a session loads comes first.
      const own = (): YourMcpServerDto | undefined => {
        const now = deps.mcp(projectId);
        const found = now.servers.filter(
          (s) => hostOf(s.url) === host && harnessReadsServer(harness, s.key),
        );
        return found.find((s) => now.loaded[s.name] === s.key) ?? found[0];
      };
      let server = own();
      if (server === undefined) {
        const source =
          harness === Provider.Codex ? YourMcpSource.CodexConfig : YourMcpSource.ClaudeJson;
        const clash = deps
          .mcp(projectId)
          .servers.find((s) => s.source === source && s.name === entry.name);
        if (clash !== undefined)
          throw new ConflictError(
            `A server named ${entry.name} already exists with another address, so ${label} was not added. Rename or remove it, then connect again.`,
          );
        await add(harness, entry, label);
        server = own();
        if (server === undefined)
          throw new ConflictError(`${label} was added, but 10db can't read it back.`);
      }

      // The builder pressed Connect for this service, so its server is approved, and only a server at the
      // address of a CONNECTABLE_SERVICES entry: nothing else is ever approved here. A server whose config
      // changed since it was approved is approved again, as the builder reviewed it by pressing Connect.
      if (server.state === YourMcpServerState.New || server.state === YourMcpServerState.Changed) {
        if (server.configHash === null)
          throw new ConflictError(server.reason ?? `10db can't run this ${label} server.`);
        await deps.approve({ key: server.key, configHash: server.configHash });
      }

      // Approved is not loaded: the project's switches and the entry's own `enabled` still decide.
      const now = deps.mcp(projectId);
      if (!now.on)
        throw new ConflictError(
          `Your MCP Servers is off for this project, so its sessions won't load ${label}. Turn it on under Settings › Trust.`,
        );
      // The server sessions load under its name: ours, or another source's of the same name.
      const winnerKey = now.loaded[server.name];
      if (winnerKey === undefined)
        throw new ConflictError(
          `The ${label} server is switched off, in its switch under Settings › Trust › Your MCP Servers or by enabled = false in its own config, so sessions won't load it. Turn it on there.`,
        );
      if (winnerKey !== server.key) {
        const other = now.servers.find((s) => s.key === winnerKey);
        if (other === undefined || hostOf(other.url) !== host)
          throw new ConflictError(
            `A server named ${server.name} from ${other?.source ?? 'another source'} is loaded in its place, so sessions won't get ${label}. Rename or remove it under Settings › Trust › Your MCP Servers.`,
          );
        server = other;
      }

      if (harness !== Provider.Codex) return { next: ConnectNext.ClaudeCode };
      const { rows } = await deps.mcpSignIns.list();
      const mine = rows.find((r) => r.accountId === account.id && r.key === server.key);
      if (mine?.state === McpSignInState.SignedIn) {
        deps.whenWorks?.(service, projectId);
        return { next: ConnectNext.SignedIn };
      }
      const id = `${account.id}:${server.key}`;
      pending.set(id, [
        ...(pending.get(id) ?? []).filter((p) => p.projectId !== projectId),
        { service, projectId },
      ]);
      const start: StartMcpSignIn = { accountId: account.id, key: server.key };
      await deps.mcpSignIns.start(start);
      return { next: ConnectNext.SigningIn };
    },
  };
}
