import { z } from 'zod';
import { InboxItemId, ProjectId } from './ids';
import { KeepAwakeMode } from './states';

/** The tools the system check looks for: on the login PATH, but git in the daemon's fixed install prefixes. */
export const ToolName = {
  Claude: 'claude',
  Codex: 'codex',
  Git: 'git',
  Docker: 'docker',
  Gh: 'gh',
} as const;
export type ToolName = (typeof ToolName)[keyof typeof ToolName];

export const ToolCheck = z.object({
  name: z.enum(ToolName),
  path: z.string().nullable(),
  version: z.string().nullable(),
  required: z.boolean(),
  /** gh only: the GitHub login it is signed in as; null when signed out, unprobed or the probe failed. */
  signedIn: z.string().nullable().default(null),
});
export type ToolCheck = z.infer<typeof ToolCheck>;

export const AgentCopyState = { Fetching: 'fetching', Ready: 'ready', Refused: 'refused' } as const;
export type AgentCopyState = (typeof AgentCopyState)[keyof typeof AgentCopyState];

/**
 * One agent CLI as 10db runs it: the copy it fetched at the release it is verified on. A copy that is
 * fetching can't start a session yet; a refused one failed its checksum or its download, and `problem` says why.
 * `newerRelease` is upstream's newest release when it is later than `pinned`.
 */
export const AgentCopy = z.object({
  tool: z.enum([ToolName.Claude, ToolName.Codex]),
  label: z.string(),
  pinned: z.string(),
  state: z.enum(AgentCopyState),
  problem: z.string().nullable(),
  newerRelease: z.string().nullable(),
});
export type AgentCopy = z.infer<typeof AgentCopy>;

/**
 * An Artificial Analysis sync that failed and no later sync has cleared. Routing keeps the last good
 * scores meanwhile, so steps can fall back to the project default without any other sign.
 */
export const BenchmarkSyncWarning = z.object({
  outcome: z.enum(['unauthorized', 'rate_limited', 'failed']),
  message: z.string(),
});
export type BenchmarkSyncWarning = z.infer<typeof BenchmarkSyncWarning>;

/** What `GET /system` reports: where each tool is, and whether the login-shell capture worked. */
export const SystemCheckDto = z.object({
  loginEnv: z.object({
    source: z.enum(['login_shell', 'inherited']),
    warning: z.string().nullable(),
  }),
  /** The Claude Code version the account checks were verified on, and a warning on a newer major version (accounts spec §10). */
  claudeCode: z.object({ verifiedOn: z.string(), warning: z.string().nullable() }),
  /** The Codex version the ChatGPT-plan checks were verified on, and a warning on any other version. */
  codex: z.object({ verifiedOn: z.string(), warning: z.string().nullable() }),
  tools: z.array(ToolCheck),
  /** The pinned copies of Claude Code and Codex 10db runs; absent where none are managed (tests, fake sessions). */
  agents: z.array(AgentCopy).optional(),
  benchmarkSync: BenchmarkSyncWarning.nullable().default(null),
});
export type SystemCheckDto = z.infer<typeof SystemCheckDto>;

/** How a repo `.mcp.json` server is reached. */
export const McpTransport = { Stdio: 'stdio', Http: 'http', Sse: 'sse' } as const;
export type McpTransport = (typeof McpTransport)[keyof typeof McpTransport];

const ConfigHash = z.string().regex(/^[0-9a-f]{64}$/);

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/**
 * `*.` or nothing, then two or more lower-case labels. The last label is never one a URL parser reads as
 * part of an IPv4 address (all digits, or `0x` and hex digits), so no address passes as a name.
 */
const HOST = new RegExp(
  `^(?:\\*\\.)?(?:${HOST_LABEL}\\.)+(?!(?:[0-9]+|0x[0-9a-f]*)$)${HOST_LABEL}$`,
);
const HOST_MESSAGE =
  'must be a lower-case host name such as registry.npmjs.org, or *. and a domain such as *.example.org; no IP address, port or localhost';

/**
 * A host a repo stdio MCP server's approval names: a DNS name, or `*.` and a name of two or more
 * labels, which srt matches as every subdomain of it. No IP address, port or `localhost` name: the
 * server's sandbox never reaches loopback, where other sandboxes' proxies listen.
 */
export const McpHost = z
  .string()
  .max(253)
  .regex(HOST, HOST_MESSAGE)
  .refine((value) => value !== 'localhost' && !value.endsWith('.localhost'), HOST_MESSAGE);
export type McpHost = z.infer<typeof McpHost>;

/** One `env` or `headers` entry as the repo wrote it: the value keeps its `${NAME}` references, never an expanded value. */
export const McpConfigEntry = z.object({ name: z.string(), value: z.string() });
export type McpConfigEntry = z.infer<typeof McpConfigEntry>;

/**
 * A repo `.mcp.json` server as the builder reviews it: exactly what would run or be
 * contacted, and the names, never the values, of what it reads. `configHash` is the SHA-256 of the
 * server's normalized config, before expansion; an approval covers that hash only.
 */
export const McpServerReview = z.object({
  name: z.string().min(1),
  configHash: ConfigHash,
  transport: z.enum(McpTransport),
  /** stdio: the command and its arguments, as written. */
  command: z.string().nullable(),
  args: z.array(z.string()),
  /** http and sse: the URL, as written. */
  url: z.string().nullable(),
  /** The declared `env` block (stdio), sorted by name. It is merged over PATH and HOME, so it changes what runs. */
  env: z.array(McpConfigEntry),
  /** The declared `headers` block (http, sse), sorted by name. */
  headers: z.array(McpConfigEntry),
  /** Every `${NAME}` the config references, sorted. Approving the server allows exactly these. */
  variables: z.array(z.string()),
  /** The referenced names that look like credentials: shown as a warning on the card. */
  sensitive: z.array(z.string()),
  /**
   * stdio: the hosts `.10db/mcp-hosts.json` names for it, sorted, and part of `configHash`. Approving
   * opens exactly these. A review stored without the field parses with none.
   */
  hosts: z.array(McpHost).default([]),
});
export type McpServerReview = z.infer<typeof McpServerReview>;

/** The options on an MCP approval card. */
export const McpApprovalChoice = { Approve: 'approve', Deny: 'deny' } as const;
export type McpApprovalChoice = (typeof McpApprovalChoice)[keyof typeof McpApprovalChoice];

export const McpVerdict = { Approved: 'approved', Denied: 'denied' } as const;
export type McpVerdict = (typeof McpVerdict)[keyof typeof McpVerdict];

/** One project's verdict on one exact server config. */
export const McpApprovalDto = z.object({
  projectId: ProjectId,
  serverName: z.string().min(1),
  configHash: ConfigHash,
  verdict: z.enum(McpVerdict),
  /** The variables the approval lets 10db expand into this server. Empty when denied. */
  variables: z.array(z.string()),
  /** The hosts the approval lets this server reach. Empty when denied. */
  hosts: z.array(McpHost),
  sourceInboxId: InboxItemId.nullable(),
  /** When the verdict was last recorded; a later answer for the same config replaces it. */
  updatedAt: z.iso.datetime(),
});
export type McpApprovalDto = z.infer<typeof McpApprovalDto>;

/** `POST /projects/:projectId/mcp-servers/review`: each repo server, and where its approval stands. */
export const McpServerStatusDto = McpServerReview.extend({
  verdict: z.enum([McpVerdict.Approved, McpVerdict.Denied, 'pending']),
  /** The open approval card, while the verdict is pending. */
  inboxId: InboxItemId.nullable(),
});
export type McpServerStatusDto = z.infer<typeof McpServerStatusDto>;

export const KeepAwakeStatus = z.object({ mode: z.enum(KeepAwakeMode), active: z.boolean() });
export type KeepAwakeStatus = z.infer<typeof KeepAwakeStatus>;

/** Whether lanes decide routine permissions with Claude Code's auto mode; read when each session starts. */
export const LanePermissionsDto = z.object({ autoMode: z.boolean() });
export type LanePermissionsDto = z.infer<typeof LanePermissionsDto>;

/** The newest event's seq, so a fresh UI can stream from now instead of replaying history. */
export const EventsHead = z.object({ seq: z.int().min(0) });
export type EventsHead = z.infer<typeof EventsHead>;

export const KeepAwakeInput = z.object({ mode: z.enum(KeepAwakeMode) });
export type KeepAwakeInput = z.infer<typeof KeepAwakeInput>;

/** The `detail` key of an MCP approval card; it holds the server's `McpServerReview`. */
export const MCP_APPROVAL_DETAIL = 'mcpApproval';

/** The `detail` key of a permission card for an approved project MCP server's tool; it holds a `McpToolGrant`. */
export const MCP_TOOL_GRANT_DETAIL = 'mcpToolGrant';

/**
 * What "always allow every tool of this server" would cover, fixed when the card is raised: the server, the
 * config hash its session is running (the one the builder approved), and the tool names the server listed
 * then. A tool the server adds later, or a changed config, is not in it.
 */
export const McpToolGrant = z.object({
  name: z.string().min(1),
  configHash: ConfigHash,
  tools: z.array(z.string().min(1)).min(1),
});
export type McpToolGrant = z.infer<typeof McpToolGrant>;
