import { z } from 'zod';
import { McpConfigEntry, McpTransport } from './system';

// The builder's own MCP servers (Settings › Trust): read from `~/.claude.json`, `~/.codex/config.toml` and
// the builder's installed plugins, and run as Claude Code runs them once approved.

/** Where one of the builder's servers is declared. */
export const YourMcpSource = {
  ClaudeJson: 'claude_json',
  CodexConfig: 'codex_config',
  Plugin: 'plugin',
} as const;
export type YourMcpSource = (typeof YourMcpSource)[keyof typeof YourMcpSource];

/** Where a server stands: a plugin's is approved from the start, since installing the plugin approved it. */
export const YourMcpServerState = {
  New: 'new',
  Changed: 'changed',
  Approved: 'approved',
  LeftOut: 'left_out',
} as const;
export type YourMcpServerState = (typeof YourMcpServerState)[keyof typeof YourMcpServerState];

/**
 * One server's key: its source, its plugin for a plugin's, and its name, each part URI-encoded so any name a
 * file holds has a key. Derived from the declaration, never minted.
 */
export const YourMcpServerKey = z
  .string()
  .regex(/^(?:claude_json|codex_config|plugin:[A-Za-z0-9%._~!*'()-]+):[A-Za-z0-9%._~!*'()-]+$/)
  .brand<'YourMcpServerKey'>();
export type YourMcpServerKey = z.infer<typeof YourMcpServerKey>;

/** A plugin server's key needs its plugin id; a file's needs none. */
export function yourMcpServerKey(
  source: YourMcpSource,
  name: string,
  pluginId?: string,
): YourMcpServerKey {
  const at =
    source === YourMcpSource.Plugin ? `plugin:${encodeURIComponent(pluginId ?? '')}` : source;
  return YourMcpServerKey.parse(`${at}:${encodeURIComponent(name)}`);
}

/** One of the builder's servers as Settings › Trust shows it. No secret value is in it. */
export const YourMcpServerDto = z.strictObject({
  key: YourMcpServerKey,
  name: z.string(),
  source: z.enum(YourMcpSource),
  pluginId: z.string().nullable(),
  transport: z.enum(McpTransport).nullable(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  cwd: z.string().nullable(),
  url: z.string().nullable(),
  envNames: z.array(z.string()),
  headerNames: z.array(z.string()),
  /** The env entries whose values the hash covers: every one but the secret-named ones. */
  shownEnv: z.array(McpConfigEntry),
  /** Null for a left-out entry that could not be parsed. */
  configHash: z.string().nullable(),
  state: z.enum(YourMcpServerState),
  reason: z.string().nullable(),
  on: z.boolean(),
  /** The keys only Codex applies, such as its tool filters. */
  codexOnly: z.array(z.string()),
  /** The tool filters an approval covers, as `config.toml` sets them: null where no allow list is set. */
  enabledTools: z.array(z.string()).nullable(),
  disabledTools: z.array(z.string()),
  /** A remote server with no header and no bearer token, which likely signs in with OAuth. */
  sendsNoHeaders: z.boolean(),
});
export type YourMcpServerDto = z.infer<typeof YourMcpServerDto>;

/** `POST /settings/trust/mcp-servers/approve`: approves one server's exact config. */
export const ApproveYourMcpServer = z.strictObject({
  key: YourMcpServerKey,
  configHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApproveYourMcpServer = z.infer<typeof ApproveYourMcpServer>;
