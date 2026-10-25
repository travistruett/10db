import { z } from 'zod';
import { InboxItemId, ProjectId } from './ids';
import { KeepAwakeMode } from './states';

/** The tools the system check looks for on the login PATH. */
export const ToolName = { Claude: 'claude', Git: 'git', Docker: 'docker', Gh: 'gh' } as const;
export type ToolName = (typeof ToolName)[keyof typeof ToolName];

export const ToolCheck = z.object({
  name: z.enum(ToolName),
  path: z.string().nullable(),
  version: z.string().nullable(),
  required: z.boolean(),
});
export type ToolCheck = z.infer<typeof ToolCheck>;

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
  tools: z.array(ToolCheck),
  benchmarkSync: BenchmarkSyncWarning.nullable().default(null),
});
export type SystemCheckDto = z.infer<typeof SystemCheckDto>;

/** How a repo `.mcp.json` server is reached. */
export const McpTransport = { Stdio: 'stdio', Http: 'http', Sse: 'sse' } as const;
export type McpTransport = (typeof McpTransport)[keyof typeof McpTransport];

const ConfigHash = z.string().regex(/^[0-9a-f]{64}$/);

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

/** The newest event's seq, so a fresh UI can stream from now instead of replaying history. */
export const EventsHead = z.object({ seq: z.int().min(0) });
export type EventsHead = z.infer<typeof EventsHead>;

export const KeepAwakeInput = z.object({ mode: z.enum(KeepAwakeMode) });
export type KeepAwakeInput = z.infer<typeof KeepAwakeInput>;

/** The `detail` key of an MCP approval card; it holds the server's `McpServerReview`. */
export const MCP_APPROVAL_DETAIL = 'mcpApproval';
