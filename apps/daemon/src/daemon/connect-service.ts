import { execFile } from 'node:child_process';
import {
  CONNECTABLE_SERVICE_LABELS,
  ConflictError,
  ConnectNext,
  McpSignInState,
  Provider,
  YourMcpServerState,
  YourMcpSource,
  harnessOf,
  type ApproveYourMcpServer,
  type ConnectServiceDto,
  type ConnectableService,
  type McpSignInsDto,
  type ProjectId,
  type StartMcpSignIn,
  type YourMcpServerDto,
} from '@10db/contracts';
import { getAccountRow, getProject } from '@10db/db';
import { z } from 'zod';
import type { McpSignIns } from '../accounts';
import { AgentState, AgentTool, AUTOUPDATE_OFF, type AgentTools } from '../environment';
import type { StateStore } from '../events';

/** One service Connect sets up: the name its server gets and its address. Only its own host is ever approved. */
interface ConnectableEntry {
  readonly name: string;
  readonly url: string;
}

export const CONNECTABLE_SERVICES: Readonly<Record<ConnectableService, ConnectableEntry>> = {
  linear: { name: 'linear', url: 'https://mcp.linear.app/mcp' },
};

const CLI_TIMEOUT_MS = 30_000;

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

export interface ServiceConnector {
  /**
   * Adds the service's server to the project account's agent config when it has none at the service's host,
   * approves it, and signs the account in (Codex) or leaves `/mcp` to the builder (Claude Code). A step that
   * already holds is skipped, so a repeat is safe. Throws ConflictError with the reason when a step can't run.
   */
  connect(service: ConnectableService, projectId: ProjectId): Promise<ConnectServiceDto>;
}

export function createServiceConnector(deps: {
  readonly state: StateStore;
  /** The builder's servers as Settings › Trust lists them, read now. */
  readonly servers: () => readonly YourMcpServerDto[];
  /** Settings › Trust's Approve. */
  readonly approve: (input: ApproveYourMcpServer) => Promise<unknown>;
  readonly mcpSignIns: Pick<McpSignIns, 'list' | 'start'>;
  readonly agents: () => AgentTools | null;
  /** The login environment without billing switches. */
  readonly loginEnv: () => Readonly<Record<string, string>>;
  readonly builderHome: string;
  /** The child process boundary; tests replace it. */
  readonly run?: RunCli;
}): ServiceConnector {
  const run = deps.run ?? runCli;

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
    const env = { ...Object.fromEntries(rest), ...AUTOUPDATE_OFF, HOME: deps.builderHome };
    const args =
      harness === Provider.Codex
        ? ['mcp', 'add', entry.name, '--url', entry.url]
        : ['mcp', 'add', '--transport', 'http', '--scope', 'user', entry.name, entry.url];
    const result = await run(status.path, args, env);
    if (result.code !== 0) {
      const said = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
      throw new ConflictError(`${status.label} couldn't add ${label}: ${said.slice(0, 300)}`);
    }
  };

  return {
    async connect(service, projectId) {
      const entry = CONNECTABLE_SERVICES[service];
      const label = CONNECTABLE_SERVICE_LABELS[service];
      const host = hostOf(entry.url);
      const project = getProject(deps.state.db, projectId);
      const account = getAccountRow(deps.state.db, project.accountId);
      const harness = harnessOf(account);
      if (harness === null) throw new ConflictError(`This project's account can't run ${label}.`);

      const own = (): YourMcpServerDto | undefined =>
        deps.servers().find((s) => hostOf(s.url) === host);
      let server = own();
      if (server === undefined) {
        const source =
          harness === Provider.Codex ? YourMcpSource.CodexConfig : YourMcpSource.ClaudeJson;
        const clash = deps.servers().find((s) => s.source === source && s.name === entry.name);
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
      // address of a CONNECTABLE_SERVICES entry: nothing else is ever approved here.
      if (server.state === YourMcpServerState.New || server.state === YourMcpServerState.Changed) {
        if (server.configHash === null)
          throw new ConflictError(server.reason ?? `10db can't run this ${label} server.`);
        await deps.approve({ key: server.key, configHash: server.configHash });
      }

      if (harness !== Provider.Codex) return { next: ConnectNext.ClaudeCode };
      const rows: McpSignInsDto['rows'] = (await deps.mcpSignIns.list()).rows;
      const mine = rows.find((r) => r.accountId === account.id && r.key === server.key);
      if (mine?.state === McpSignInState.SignedIn) return { next: ConnectNext.SignedIn };
      const start: StartMcpSignIn = { accountId: account.id, key: server.key };
      await deps.mcpSignIns.start(start);
      return { next: ConnectNext.SigningIn };
    },
  };
}
