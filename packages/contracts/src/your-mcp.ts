import { z } from 'zod';
import { AccountId } from './ids';
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
  /** A remote server's `oauth` block as text, which an approval covers: its keys and values, or none. */
  oauth: z.array(McpConfigEntry),
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

/** Where one account's sign-in to one OAuth server stands. */
export const McpSignInState = {
  SignedIn: 'signed_in',
  NotSignedIn: 'not_signed_in',
  SigningIn: 'signing_in',
  Failed: 'failed',
  Unknown: 'unknown',
} as const;
export type McpSignInState = (typeof McpSignInState)[keyof typeof McpSignInState];

/** One Codex account's sign-in to one of the builder's servers: never a url or a token. */
export const McpSignInRowDto = z.strictObject({
  accountId: AccountId,
  accountLabel: z.string(),
  key: YourMcpServerKey,
  name: z.string(),
  state: z.enum(McpSignInState),
  /** Why it failed or can't be read; null otherwise. */
  message: z.string().nullable(),
});
export type McpSignInRowDto = z.infer<typeof McpSignInRowDto>;

/** What a Claude plan account in its own folder runs to sign its servers in, in the builder's terminal. */
export const McpSignInTerminalDto = z.strictObject({
  accountId: AccountId,
  accountLabel: z.string(),
  command: z.string(),
});
export type McpSignInTerminalDto = z.infer<typeof McpSignInTerminalDto>;

/** A Claude plan account on the default folder: its servers sign in through the builder's own Claude Code. */
export const McpSignInOwnClaudeDto = z.strictObject({
  accountId: AccountId,
  accountLabel: z.string(),
});
export type McpSignInOwnClaudeDto = z.infer<typeof McpSignInOwnClaudeDto>;

/** `GET` and `POST /settings/trust/mcp-sign-ins`. */
export const McpSignInsDto = z.strictObject({
  rows: z.array(McpSignInRowDto),
  terminal: z.array(McpSignInTerminalDto),
  /** The servers a sign-in can matter for: remote, approved, sending no Authorization header. */
  candidates: z.array(YourMcpServerKey),
  ownClaudeCode: z.array(McpSignInOwnClaudeDto),
});
export type McpSignInsDto = z.infer<typeof McpSignInsDto>;

/** `POST /settings/trust/mcp-sign-ins`: starts one account's sign-in to one server, or opens its page again. */
export const StartMcpSignIn = z.strictObject({
  accountId: AccountId,
  key: YourMcpServerKey,
});
export type StartMcpSignIn = z.infer<typeof StartMcpSignIn>;

/** The data of `mcp_sign_in.changed`: which sign-in moved and where it stands. Entity `mcp_sign_in`; no url. */
export const McpSignInChangedData = z.strictObject({
  accountId: AccountId,
  key: YourMcpServerKey,
  state: z.enum(McpSignInState),
});
export type McpSignInChangedData = z.infer<typeof McpSignInChangedData>;
