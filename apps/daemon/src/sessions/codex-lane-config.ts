import { SandboxedMcpServer } from '../sandbox';
import { lanePermissions } from './codex-lane-permissions';
import type { SessionMcpServer, SessionSpec } from './types';

/** The name of the permission profile 10db's template defines and every lane thread must run under. */
export const LANE_PROFILE = 'lane';

/** A thread config was asked for a session with no lane sandbox. */
export class CodexLaneConfigError extends Error {
  override readonly name = 'CodexLaneConfigError';
}

/** The environment variable the child holds the 10db server's bearer token in. */
export const MCP_TOKEN_VARIABLE = 'TENDB_MCP_TOKEN';

/** The calls of every server go to the guard's hook, so the server's own approval prompt is skipped. */
const APPROVAL_MODE = 'approve';

/**
 * A repo server as Codex's `mcp_servers` entry. A stdio server is the lane sandbox's own launch under
 * srt through `env -i`, so it gets no `env` block, which Codex would merge over its own environment.
 */
function projectServer(server: SessionMcpServer): Record<string, unknown> {
  if (server instanceof SandboxedMcpServer) {
    const { command, args } = server.launch();
    return { command, args: [...args], default_tools_approval_mode: APPROVAL_MODE };
  }
  return {
    url: server.url,
    ...(server.headers === null ? {} : { http_headers: { ...server.headers } }),
    default_tools_approval_mode: APPROVAL_MODE,
  };
}

/**
 * The per-lane `config` for `thread/start` and `thread/resume`. It travels over stdin, never on a
 * command line, and holds the name of the token variable, never the token.
 */
export function codexThreadConfig(spec: SessionSpec): Record<string, unknown> {
  const projects = Object.fromEntries(
    Object.entries(spec.projectMcpServers).map(([name, server]) => [name, projectServer(server)]),
  );
  const { sandbox } = spec;
  if (sandbox === undefined || sandbox === null) {
    throw new CodexLaneConfigError('a Codex session needs the lane sandbox');
  }
  return {
    permissions: lanePermissions(sandbox),
    shell_environment_policy: { inherit: 'none', set: { ...sandbox.shellEnv } },
    mcp_servers: {
      ...projects,
      '10db': {
        url: spec.mcp.url,
        bearer_token_env_var: MCP_TOKEN_VARIABLE,
        required: true,
        default_tools_approval_mode: APPROVAL_MODE,
        tool_timeout_sec: spec.mcp.toolTimeoutMs / 1000,
      },
    },
  };
}
