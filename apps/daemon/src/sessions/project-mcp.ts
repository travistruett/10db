import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  McpTransport,
  McpVerdict,
  type McpConfigEntry,
  type McpServerReview,
} from '@10db/contracts';
import { z } from 'zod';

/** 10db's own MCP server in every managed session. A repo server with this name never replaces it. */
export const TENDB_MCP_SERVER = '10db';
/**
 * The only session variables a stdio server gets without naming them in its config. Measured:
 * `npx -y @mantine/mcp-server` downloads, starts and lists its tools with these two alone. macOS adds
 * `__CF_USER_TEXT_ENCODING` inside the process itself under `env -i`; it is not a session variable.
 */
export const STDIO_BASE_ENV = ['PATH', 'HOME'] as const;
const PROJECT_MCP_FILE = '.mcp.json';
/** `${NAME}` or `${NAME:-default}`, as Claude Code writes them in `.mcp.json`. */
const VARIABLE_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names that look like credentials: 10db's billing, Claude Code's and AWS's, and anything named like a secret. */
const SENSITIVE_NAME = /^(?:ANTHROPIC_|CLAUDE_|AWS_)|TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL/i;

/** A server name: it ends up in tool names (`mcp__<name>__*`) and on the approval card. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** An HTTP header name is an RFC 9110 token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A `.mcp.json` larger than this is not a config; it is refused unread. */
export const MCP_FILE_MAX_BYTES = 256 * 1024;

/** http or https only; a `${VAR}` may stand in the URL, which the URL parser accepts. */
const RemoteUrl = z.string().refine(
  (value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'must be an http or https URL' },
);
const HeaderMap = z.record(
  z.string().regex(HEADER_NAME, 'must be an HTTP header name'),
  z.string(),
);
const StdioServer = z.strictObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string().regex(ENV_NAME, 'must be a variable name'), z.string()).optional(),
});
const RemoteServer = z.strictObject({
  type: z.enum(['http', 'sse']),
  url: RemoteUrl,
  headers: HeaderMap.optional(),
});
const McpFile = z.strictObject({
  mcpServers: z.record(
    z.string().regex(SERVER_NAME, 'must be 1 to 64 letters, digits, "_" or "-"'),
    z.union([StdioServer, RemoteServer]),
  ),
});
type DeclaredServer = z.infer<typeof StdioServer> | z.infer<typeof RemoteServer>;

/** A repo-declared MCP server, approved and with every `${VAR}` expanded. Provider-neutral. */
export type ProjectMcpServer =
  | {
      readonly type: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      /** The server's whole environment: nothing else from the session reaches it. */
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'http' | 'sse';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>> | null;
    };

/** One server as the repo declares it, before approval or expansion. */
export interface RepoMcpServer {
  readonly name: string;
  readonly declared: DeclaredServer;
  readonly review: McpServerReview;
}

/** The repo's `.mcp.json`, parsed. */
export interface RepoMcp {
  readonly servers: readonly RepoMcpServer[];
  /** Servers ignored for their name; the runner raises each as an inbox flag. */
  readonly warnings: readonly string[];
}

/** The builder's verdict on one exact config. */
export interface McpApproval {
  readonly verdict: McpVerdict;
  readonly variables: readonly string[];
}

export interface ProjectMcp {
  /** Approved servers, ready to pass to a managed session next to 10db's own. */
  readonly servers: Readonly<Record<string, ProjectMcpServer>>;
  readonly warnings: readonly string[];
  /** Servers with no verdict for their current config: each needs an approval card. */
  readonly pending: readonly McpServerReview[];
  readonly denied: readonly string[];
  /** Approved servers 10db can't run as written. Each message names the server and the variable or field. */
  readonly failures: readonly { readonly name: string; readonly message: string }[];
}

/** The repo's `.mcp.json` can't be used as written. The message names the file, and the server and field when there is one. */
export class ProjectMcpError extends Error {
  override readonly name = 'ProjectMcpError';
}

/** The `code` of a Node file-system error, or undefined for anything else. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function readMcpFile(path: string): string | null {
  try {
    // lstat, not stat: a tracked symlink to a device or a huge file must never be opened.
    const stat = lstatSync(path);
    if (!stat.isFile()) {
      throw new ProjectMcpError(`${path} must be a regular file, not a link or a device`);
    }
    if (stat.size > MCP_FILE_MAX_BYTES) {
      throw new ProjectMcpError(`${path} is larger than ${String(MCP_FILE_MAX_BYTES / 1024)} KiB`);
    }
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ProjectMcpError) throw error;
    const code = errorCode(error);
    if (code === 'ENOENT') return null;
    throw new ProjectMcpError(`${path} could not be read (${code ?? 'error'})`);
  }
}

function parseMcpFile(path: string, text: string): z.infer<typeof McpFile> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ProjectMcpError(
      `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        'Fix it, or remove it, so 10db can start sessions in this repo.',
    );
  }
  const parsed = McpFile.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ProjectMcpError(`${path} is not a valid MCP config: ${issues.join('; ')}`);
  }
  return parsed.data;
}

const sortedEntries = (map: Readonly<Record<string, string>> | undefined): [string, string][] =>
  Object.entries(map ?? {}).sort(([a], [b]) => a.localeCompare(b));

/** The config as 10db hashes it: defaults filled in and maps sorted, before any expansion. */
function normalized(server: DeclaredServer): unknown {
  return 'command' in server
    ? {
        transport: McpTransport.Stdio,
        command: server.command,
        args: server.args ?? [],
        env: sortedEntries(server.env),
      }
    : { transport: server.type, url: server.url, headers: sortedEntries(server.headers) };
}

function referencedNames(values: readonly string[]): string[] {
  const names = values.flatMap((value) =>
    [...value.matchAll(VARIABLE_REF)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])),
  );
  return [...new Set(names)].sort();
}

const entriesOf = (map: Readonly<Record<string, string>> | undefined): McpConfigEntry[] =>
  sortedEntries(map).map(([name, value]) => ({ name, value }));

/** What the builder sees on the approval card, and the hash the approval is keyed on. */
function reviewOf(name: string, server: DeclaredServer): McpServerReview {
  const stdio = 'command' in server;
  const values = stdio
    ? [server.command, ...(server.args ?? []), ...Object.values(server.env ?? {})]
    : [server.url, ...Object.values(server.headers ?? {})];
  const variables = referencedNames(values);
  return {
    name,
    configHash: createHash('sha256')
      .update(JSON.stringify(normalized(server)))
      .digest('hex'),
    transport: stdio ? McpTransport.Stdio : server.type,
    command: stdio ? server.command : null,
    args: stdio ? [...(server.args ?? [])] : [],
    url: stdio ? null : server.url,
    env: stdio ? entriesOf(server.env) : [],
    headers: stdio ? [] : entriesOf(server.headers),
    variables,
    sensitive: variables.filter((v) => SENSITIVE_NAME.test(v)),
  };
}

/** 10db's server is `10db` and `mcp__10db__*` is allowed without asking, so no repo name may start with it or contain `__`. */
function reservedName(name: string): boolean {
  return name.startsWith(TENDB_MCP_SERVER) || name.includes('__');
}

/**
 * The repo's `.mcp.json`, parsed and reviewed, but not yet approved or expanded. A missing file means no
 * servers. An unreadable or invalid file throws, so it is never silently ignored.
 */
export function readRepoMcp(repoPath: string): RepoMcp {
  const path = join(repoPath, PROJECT_MCP_FILE);
  const text = readMcpFile(path);
  if (text === null) return { servers: [], warnings: [] };
  const file = parseMcpFile(path, text);
  const servers: RepoMcpServer[] = [];
  const warnings: string[] = [];
  for (const [name, declared] of Object.entries(file.mcpServers)) {
    if (reservedName(name)) {
      warnings.push(
        `The repo's .mcp.json declares a server named "${name}". 10db's own server is "${TENDB_MCP_SERVER}" and its ` +
          `tools are allowed as mcp__${TENDB_MCP_SERVER}__*, so a repo server whose name starts with "${TENDB_MCP_SERVER}" ` +
          'or contains "__" is ignored in managed sessions. Rename it to use it.',
      );
      continue;
    }
    servers.push({ name, declared, review: reviewOf(name, declared) });
  }
  return { servers, warnings };
}

interface ExpandScope {
  readonly env: Readonly<Record<string, string>>;
  readonly approved: ReadonlySet<string>;
}

/**
 * Expands `${NAME}` and `${NAME:-default}` from the session environment, for approved names only. The
 * result may hold no `${`, so Claude Code can't expand anything more from its own environment.
 */
function expand(
  value: string,
  scope: ExpandScope,
  where: { readonly server: string; readonly field: string },
): string {
  const at = `.mcp.json server "${where.server}" (${where.field})`;
  const result = value.replace(VARIABLE_REF, (_ref, name: string, fallback: string | undefined) => {
    if (!scope.approved.has(name)) {
      throw new ProjectMcpError(
        `${at} references \${${name}}, which this project's approval of "${where.server}" doesn't cover. ` +
          'Approve the server again from its card to allow it.',
      );
    }
    const found = scope.env[name];
    if (found !== undefined) return found;
    if (fallback !== undefined) return fallback;
    throw new ProjectMcpError(
      `${at} references \${${name}}, which is not set in the session environment. ` +
        `Export ${name} in your login shell and restart 10db, or write \${${name}:-default}.`,
    );
  });
  if (result.includes('${')) {
    throw new ProjectMcpError(
      `${at} still contains "\${" after expansion, which Claude Code would expand from its own environment.`,
    );
  }
  return result;
}

function expandMap(
  map: Readonly<Record<string, string>>,
  scope: ExpandScope,
  server: string,
  field: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).map(([key, value]) => [
      key,
      expand(value, scope, { server, field: `${field}.${key}` }),
    ]),
  );
}

/** One approved server, expanded. A stdio server gets PATH, HOME and its declared `env`, and nothing else. */
function resolveServer(server: RepoMcpServer, scope: ExpandScope): ProjectMcpServer {
  const { name, declared } = server;
  if ('command' in declared) {
    const command = expand(declared.command, scope, { server: name, field: 'command' });
    // 10db launches it as `env -i NAME=value … <command>`, where a leading "-" or an "=" would change the meaning.
    if (command.startsWith('-') || command.includes('=')) {
      throw new ProjectMcpError(
        `.mcp.json server "${name}" (command) can't start with "-" or contain "="; point it at a script instead.`,
      );
    }
    const base = Object.fromEntries(
      STDIO_BASE_ENV.flatMap((key) =>
        scope.env[key] === undefined ? [] : [[key, scope.env[key]]],
      ),
    );
    return {
      type: 'stdio',
      command,
      args: (declared.args ?? []).map((arg, i) =>
        expand(arg, scope, { server: name, field: `args[${String(i)}]` }),
      ),
      env: { ...base, ...expandMap(declared.env ?? {}, scope, name, 'env') },
    };
  }
  return {
    type: declared.type,
    url: expand(declared.url, scope, { server: name, field: 'url' }),
    headers: declared.headers ? expandMap(declared.headers, scope, name, 'headers') : null,
  };
}

/**
 * Sorts the repo's servers by the builder's verdicts. Approved ones are expanded from the
 * session environment, with only the variables their approval names; the rest are left out and reported.
 * Nothing here stops the session from starting.
 */
export function resolveProjectMcp(input: {
  readonly repo: RepoMcp;
  readonly env: Readonly<Record<string, string>>;
  readonly approvalFor: (review: McpServerReview) => McpApproval | null;
}): ProjectMcp {
  const servers: Record<string, ProjectMcpServer> = {};
  const pending: McpServerReview[] = [];
  const denied: string[] = [];
  const failures: { name: string; message: string }[] = [];
  for (const server of input.repo.servers) {
    const approval = input.approvalFor(server.review);
    if (approval === null) {
      pending.push(server.review);
    } else if (approval.verdict === McpVerdict.Denied) {
      denied.push(server.name);
    } else {
      try {
        servers[server.name] = resolveServer(server, {
          env: input.env,
          approved: new Set(approval.variables),
        });
      } catch (error) {
        if (!(error instanceof ProjectMcpError)) throw error;
        failures.push({ name: server.name, message: error.message });
      }
    }
  }
  return { servers, warnings: input.repo.warnings, pending, denied, failures };
}

/** A line for the session's prompt when repo servers are left out, so the agent doesn't hunt for their tools. */
export function skippedServersNote(mcp: ProjectMcp): string | null {
  const skipped = [
    ...mcp.pending.map((r) => `${r.name} (waiting for the builder's approval)`),
    ...mcp.denied.map((name) => `${name} (denied by the builder)`),
    ...mcp.failures.map((f) => `${f.name} (its config can't be used as written)`),
  ];
  if (skipped.length === 0) return null;
  return (
    `Note from 10db: these MCP servers from the repo's .mcp.json are not in this session: ${skipped.join('; ')}. ` +
    "Don't look for their tools. Work without them, or say in your handoff that the task needs one."
  );
}
