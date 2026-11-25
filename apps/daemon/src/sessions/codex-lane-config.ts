import { SandboxedMcpServer } from '../sandbox';
import { CODEX_TUI_DEFAULTS, MCP_TOKEN_PREFIX } from './codex-takeover';
import { isFullAccess } from './full-access';
import { lanePermissions, readOnlyPermissions } from './codex-lane-permissions';
import { codexYourServers } from './codex-your-servers';
import type { AgentSessionSpec, SessionMcpServer } from './types';

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

/** The session's MCP servers: the project's, then the builder's, then 10db's own. */
function mcpServers(spec: AgentSessionSpec): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      Object.entries(spec.projectMcpServers).map(([name, server]) => [name, projectServer(server)]),
    ),
    ...codexYourServers(spec),
    '10db': {
      url: spec.mcp.url,
      bearer_token_env_var: MCP_TOKEN_VARIABLE,
      required: true,
      default_tools_approval_mode: APPROVAL_MODE,
      tool_timeout_sec: spec.mcp.toolTimeoutMs / 1000,
    },
  };
}

/**
 * The per-session `config` for `thread/start` and `thread/resume`: a lane's, or an explore
 * conversation's on its read-only sandbox, whose checkout the profile makes `read`; with no lane sandbox it is
 * read-only too, `secretFiles` of the checkout denied. The project's servers come
 * first, then the builder's, then 10db's. It travels over stdin, never on a
 * command line, and holds the name of the token variable, never the token.
 */
export function codexThreadConfig(
  spec: AgentSessionSpec,
  secretFiles: readonly string[] = [],
): Record<string, unknown> {
  const mcp = mcpServers(spec);
  // A Full access chat runs Codex's full-access mode (the thread's `sandbox` param): no permission profile, the
  // shell as a terminal's, and the managed network proxy off. Its commands never hold 10db's server token or a key.
  if (isFullAccess(spec))
    return {
      ...((spec.setup?.skillRoots ?? []).length > 0
        ? { skills: { include_instructions: true } }
        : {}),
      web_search: spec.webSearch ?? 'disabled',
      allow_login_shell: CODEX_TUI_DEFAULTS.allowLoginShell,
      features: { network_proxy: CODEX_TUI_DEFAULTS.features.network_proxy },
      shell_environment_policy: {
        inherit: CODEX_TUI_DEFAULTS.shellInherit,
        exclude: [MCP_TOKEN_VARIABLE, `${MCP_TOKEN_PREFIX}*`, 'OPENROUTER_API_KEY'],
      },
      mcp_servers: mcp,
    };
  const { sandbox } = spec;
  // A conversation with no lane sandbox reads the checkout and runs no command; a lane never starts without one.
  if (sandbox === null && spec.profile.kind !== 'explore') {
    throw new CodexLaneConfigError('a Codex session needs the lane sandbox');
  }
  // With the setup's skill roots listed, Codex tells the model of its skills; every other thread keeps
  // the account template's `false` (`codex-home.ts`).
  const skills = (spec.setup?.skillRoots ?? []).length > 0;
  return {
    ...(skills ? { skills: { include_instructions: true } } : {}),
    permissions:
      sandbox === null ? readOnlyPermissions(spec.cwd, secretFiles) : lanePermissions(sandbox),
    // The thread's own setting over the home's `disabled`.
    web_search: spec.webSearch ?? 'disabled',
    shell_environment_policy: { inherit: 'none', set: { ...sandbox?.shellEnv } },
    mcp_servers: mcp,
  };
}

/**
 * What a thread is told beyond Codex's own prompt. Codex loads no AGENTS.md under `untrusted` (L4), so the
 * project's and the builder's instructions travel with the thread; an explore conversation's own prompt (Plan's or
 * a chat's) comes before them, as Claude Code appends it before the setup's. Null when there is nothing to say.
 */
export function codexDeveloperInstructions(spec: AgentSessionSpec): string | null {
  const parts = [
    ...(spec.profile.kind === 'explore' ? [spec.profile.systemPrompt] : []),
    ...(spec.instructions ? [spec.instructions] : []),
  ].filter((part) => part !== '');
  return parts.length === 0 ? null : parts.join('\n\n');
}
