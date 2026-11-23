import { YourMcpServer, SandboxedMcpServer, singleQuoted } from '../sandbox';
import { toSdkMcpServer } from './claude-mapping';
import { toYourSdkServer } from './claude-session';
import { codexKeys, oauthKeys } from './codex-your-servers';
import { McpServerName } from './mcp-server-name';
import { MCP_TOKEN_PREFIX } from './codex-takeover';
import type { RemoteMcpServer } from './project-mcp';
import type { CodexTakeoverServer } from './takeover-command';
import type { SessionMcpServer, YourSessionServer } from './types';

// Sessions spec §7.5: the servers a chat's session had, as each agent's terminal takes them. Never 10db's own
// `/mcp` server, which names tools the terminal lacks.

interface Servers {
  readonly projectMcpServers: Readonly<Record<string, SessionMcpServer>>;
  readonly yourMcpServers: Readonly<Record<string, YourSessionServer>>;
}

/** Claude's `--mcp-config` entries: the project's servers, then the builder's, keyed by name. */
export function claudeTakeoverMcp(spec: Servers): {
  readonly servers: Record<string, unknown>;
  /** Names left out because the agent's tool names can't carry them. */
  readonly leftOut: string[];
} {
  const servers: Record<string, unknown> = {};
  const leftOut: string[] = [];
  const take = (name: string, entry: () => unknown, registeredAs: string = name): void => {
    if (McpServerName.safeParse(name).success) servers[registeredAs] = entry();
    else leftOut.push(name);
  };
  for (const [name, server] of Object.entries(spec.projectMcpServers))
    take(name, () => toSdkMcpServer(server));
  // A plugin's server goes in under Claude Code's own name, where the builder's sign-in is filed.
  for (const [name, server] of Object.entries(spec.yourMcpServers))
    take(name, () => toYourSdkServer(server), server.claudeName ?? name);
  return { servers, leftOut };
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what it finds
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Codex's servers: a stdio one as its launch, a remote one with each header's value moved to a sealed
 * `export` line the terminal's script reads and deletes. A server whose name or header values can't be written
 * safely is left out.
 */
export function codexTakeoverServers(spec: Servers): {
  readonly servers: CodexTakeoverServer[];
  /** `export TENDB_MCP_TOKEN_<n>_<m>='<value>'`, one per header. */
  readonly sealed: string[];
  readonly leftOut: string[];
} {
  const servers: CodexTakeoverServer[] = [];
  const sealed: string[] = [];
  const leftOut: string[] = [];
  const remote = (
    name: string,
    connect: RemoteMcpServer,
    extras: Record<string, unknown>,
  ): void => {
    const index = servers.length;
    const headers = Object.entries(connect.headers ?? {});
    if (headers.some(([header, value]) => CONTROL_CHARACTER.test(header + value))) {
      leftOut.push(name);
      return;
    }
    const headerVariables = headers.map(([header], at) => ({
      header,
      variable: `${MCP_TOKEN_PREFIX}${String(index)}_${String(at)}`,
    }));
    for (const [at, [, value]] of headers.entries())
      sealed.push(
        `export ${MCP_TOKEN_PREFIX}${String(index)}_${String(at)}=${singleQuoted(value)}`,
      );
    servers.push({ kind: 'remote', name, url: connect.url, headerVariables, extras });
  };
  const stdio = (
    name: string,
    launch: { readonly command: string; readonly args: readonly string[] },
    extras: Record<string, unknown>,
  ): void => {
    servers.push({ kind: 'stdio', name, command: launch.command, args: launch.args, extras });
  };
  for (const [name, server] of Object.entries(spec.projectMcpServers)) {
    if (!McpServerName.safeParse(name).success) leftOut.push(name);
    else if (server instanceof SandboxedMcpServer) stdio(name, server.launch(), {});
    else remote(name, server, {});
  }
  for (const [name, server] of Object.entries(spec.yourMcpServers)) {
    if (!McpServerName.safeParse(name).success) leftOut.push(name);
    else if (server.connect instanceof YourMcpServer)
      stdio(name, server.connect.launch(), codexKeys(server.codex));
    else
      remote(name, server.connect, {
        ...oauthKeys(server.claudeOAuth),
        ...codexKeys(server.codex),
      });
  }
  return { servers, sealed, leftOut };
}
