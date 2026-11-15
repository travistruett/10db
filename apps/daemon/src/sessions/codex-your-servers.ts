import { YourMcpServer } from '../sandbox';
import type { AgentSessionCore, YourSessionServer } from './types';

/** The calls of every server go to the guard's hook, so the server's own approval prompt is skipped. */
const APPROVAL_MODE = 'approve';

/** What `~/.codex/config.toml` sets that only Codex applies, as the entry's own keys, where set. */
function codexKeys(codex: YourSessionServer['codex']): Record<string, unknown> {
  return {
    ...(codex.enabledTools === null ? {} : { enabled_tools: [...codex.enabledTools] }),
    ...(codex.disabledTools.length === 0 ? {} : { disabled_tools: [...codex.disabledTools] }),
    ...(codex.startupTimeoutSec === null ? {} : { startup_timeout_sec: codex.startupTimeoutSec }),
    ...(codex.toolTimeoutSec === null ? {} : { tool_timeout_sec: codex.toolTimeoutSec }),
  };
}

/**
 * The builder's own MCP servers as Codex's `mcp_servers` entries. A stdio server is 10db's launch from the
 * builder's home through `env -i`, so it gets no `env` block, which Codex would merge over its own
 * environment. Its tool filters and timeouts from `config.toml` apply here.
 */
export function codexYourServers(
  spec: Pick<AgentSessionCore, 'yourMcpServers'>,
): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, { connect, codex }] of Object.entries(spec.yourMcpServers)) {
    if (connect instanceof YourMcpServer) {
      const { command, args } = connect.launch();
      servers[name] = {
        command,
        args: [...args],
        default_tools_approval_mode: APPROVAL_MODE,
        ...codexKeys(codex),
      };
    } else {
      servers[name] = {
        url: connect.url,
        ...(connect.headers === null ? {} : { http_headers: { ...connect.headers } }),
        default_tools_approval_mode: APPROVAL_MODE,
        ...codexKeys(codex),
      };
    }
  }
  return servers;
}
