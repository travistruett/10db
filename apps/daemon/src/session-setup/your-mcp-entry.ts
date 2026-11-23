import { YourMcpSource, yourMcpServerKey, type YourMcpServerKey } from '@10db/contracts';
import { z } from 'zod';
import {
  ClaudeOAuth,
  describeIssuePaths,
  EnvName,
  HeaderMap,
  McpServerName,
  RemoteUrl,
  TENDB_MCP_SERVER,
  type CodexServerExtras,
} from '../sessions';
import type { LeftOut } from './left-out';
import { yourMcpConfigHash } from './your-mcp-hash';

/** One of the builder's servers as its file declares it, before approval or expansion. */
export type DeclaredYourServer =
  | {
      readonly transport: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      /** Codex's `env_vars`: names copied from the login environment. */
      readonly envVars: readonly string[];
      readonly cwd: string | null;
      readonly codex: CodexServerExtras;
    }
  | {
      readonly transport: 'http' | 'sse';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      /** Codex's `env_http_headers`: header name to the variable that holds its value. */
      readonly envHeaders: Readonly<Record<string, string>>;
      /** Codex's `bearer_token_env_var`. */
      readonly bearerTokenVar: string | null;
      /** Claude Code's `oauth` block; always null for `config.toml`. */
      readonly oauth: ClaudeOAuth | null;
      readonly codex: CodexServerExtras;
    };

/** One server a file names, read or refused. */
export interface YourMcpEntry {
  readonly key: YourMcpServerKey;
  readonly name: string;
  /** The name a Claude session registers it under, when not `name`: a plugin's remote server, as Claude Code names it. */
  readonly claudeName: string | null;
  readonly source: YourMcpSource;
  readonly pluginId: string | null;
  /** Null only when the entry didn't parse. */
  readonly declared: DeclaredYourServer | null;
  readonly configHash: string | null;
  /** Codex's `enabled`; always true for `~/.claude.json`. */
  readonly enabledInSource: boolean;
  /** Why 10db can't run it, naming a field and never a value; null when it can. */
  readonly refusal: string | null;
}

export const NO_EXTRAS: CodexServerExtras = {
  enabledTools: null,
  disabledTools: [],
  startupTimeoutSec: null,
  toolTimeoutSec: null,
};

export const ClaudeFile = z.looseObject({ mcpServers: z.unknown().optional() });
export const CodexFile = z.looseObject({ mcp_servers: z.unknown().optional() });

const ClaudeStdio = z.looseObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(EnvName, z.string()).optional(),
});
const ClaudeRemote = z.looseObject({
  type: z.enum(['http', 'sse']),
  url: RemoteUrl,
  headers: HeaderMap.optional(),
  oauth: ClaudeOAuth.optional(),
});

const CodexCommon = {
  enabled: z.boolean().optional(),
  enabled_tools: z.array(z.string()).optional(),
  disabled_tools: z.array(z.string()).optional(),
  startup_timeout_sec: z.number().positive().optional(),
  tool_timeout_sec: z.number().positive().optional(),
};
const CodexStdio = z.looseObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(EnvName, z.string()).optional(),
  env_vars: z.array(EnvName).optional(),
  cwd: z.string().optional(),
  ...CodexCommon,
});
const CodexRemote = z.looseObject({
  url: RemoteUrl,
  bearer_token_env_var: EnvName.optional(),
  http_headers: HeaderMap.optional(),
  env_http_headers: z.record(z.string(), EnvName).optional(),
  ...CodexCommon,
});

const RawEntry = z.looseObject({
  type: z.unknown().optional(),
  command: z.unknown().optional(),
  args: z.unknown().optional(),
  headersHelper: z.unknown().optional(),
});

interface Parsed {
  readonly declared: DeclaredYourServer | null;
  readonly enabled: boolean;
  /** Why it didn't parse, as issue paths only. */
  readonly unreadable: string | null;
}

function extrasOf(
  entry: z.infer<typeof CodexStdio> | z.infer<typeof CodexRemote>,
): CodexServerExtras {
  return {
    enabledTools: entry.enabled_tools ?? null,
    disabledTools: entry.disabled_tools ?? [],
    startupTimeoutSec: entry.startup_timeout_sec ?? null,
    toolTimeoutSec: entry.tool_timeout_sec ?? null,
  };
}

export function parseClaudeEntry(raw: unknown): Parsed {
  const remote = RawEntry.safeParse(raw).data?.type;
  if (remote === 'http' || remote === 'sse') {
    const parsed = ClaudeRemote.safeParse(raw);
    if (!parsed.success)
      return { declared: null, enabled: true, unreadable: describeIssuePaths(parsed.error) };
    return {
      declared: {
        transport: parsed.data.type,
        url: parsed.data.url,
        headers: parsed.data.headers ?? {},
        envHeaders: {},
        bearerTokenVar: null,
        oauth: parsed.data.oauth ?? null,
        codex: NO_EXTRAS,
      },
      enabled: true,
      unreadable: null,
    };
  }
  const parsed = ClaudeStdio.safeParse(raw);
  if (!parsed.success)
    return { declared: null, enabled: true, unreadable: describeIssuePaths(parsed.error) };
  return {
    declared: {
      transport: 'stdio',
      command: parsed.data.command,
      args: parsed.data.args ?? [],
      env: parsed.data.env ?? {},
      envVars: [],
      cwd: null,
      codex: NO_EXTRAS,
    },
    enabled: true,
    unreadable: null,
  };
}

export function parseCodexEntry(raw: unknown): Parsed {
  const stdio = RawEntry.safeParse(raw).data?.command !== undefined;
  if (stdio) {
    const parsed = CodexStdio.safeParse(raw);
    if (!parsed.success)
      return { declared: null, enabled: true, unreadable: describeIssuePaths(parsed.error) };
    return {
      declared: {
        transport: 'stdio',
        command: parsed.data.command,
        args: parsed.data.args ?? [],
        env: parsed.data.env ?? {},
        envVars: parsed.data.env_vars ?? [],
        cwd: parsed.data.cwd ?? null,
        codex: extrasOf(parsed.data),
      },
      enabled: parsed.data.enabled ?? true,
      unreadable: null,
    };
  }
  const parsed = CodexRemote.safeParse(raw);
  if (!parsed.success)
    return { declared: null, enabled: true, unreadable: describeIssuePaths(parsed.error) };
  return {
    declared: {
      transport: 'http',
      url: parsed.data.url,
      headers: parsed.data.http_headers ?? {},
      envHeaders: parsed.data.env_http_headers ?? {},
      bearerTokenVar: parsed.data.bearer_token_env_var ?? null,
      oauth: null,
      codex: extrasOf(parsed.data),
    },
    enabled: parsed.data.enabled ?? true,
    unreadable: null,
  };
}

/** 10db's own server is `10db`, and `mcp__10db__*` is allowed without asking. */
const reservedName = (name: string): boolean =>
  name.startsWith(TENDB_MCP_SERVER) || name.includes('__');

/** The first field on a command line that holds `${`, as the refusal names it. */
function expandingField(raw: z.infer<typeof RawEntry>): string | null {
  if (typeof raw.command === 'string' && raw.command.includes('${')) return 'command';
  if (!Array.isArray(raw.args)) return null;
  const index = raw.args.findIndex((arg) => typeof arg === 'string' && arg.includes('${'));
  return index < 0 ? null : `argument ${String(index + 1)}`;
}

/** Why 10db won't run an entry, in order; null when nothing refuses it. */
export function refusalOf(
  name: string,
  raw: unknown,
  source: YourMcpSource,
  parsed: Parsed,
): string | null {
  if (!McpServerName.safeParse(name).success) return "Its name can't be an MCP server name.";
  if (reservedName(name)) return "Its name is kept for 10db's own server.";
  const fields = RawEntry.safeParse(raw);
  if (!fields.success) return "It can't be read: (root)";
  if (fields.data.headersHelper !== undefined)
    return "It runs a command for its headers, which 10db doesn't run yet.";
  const type = fields.data.type;
  if (
    source !== YourMcpSource.CodexConfig &&
    type !== undefined &&
    type !== 'stdio' &&
    type !== 'http' &&
    type !== 'sse'
  )
    return "Its type isn't stdio, http or sse.";
  const field = expandingField(fields.data);
  if (field !== null)
    return `Its ${field} uses \${…}, which would put a value on a command line. Set it in its env block instead.`;
  if (typeof fields.data.command === 'string' && fields.data.command.startsWith('-'))
    return `Its command can't start with "-". Point it at a script instead.`;
  if (parsed.unreadable !== null) return `It can't be read: ${parsed.unreadable}`;
  return null;
}

export function entriesOf(
  servers: unknown,
  source: YourMcpSource,
  parse: (raw: unknown) => Parsed,
  what: string,
): { entries: YourMcpEntry[]; problems: LeftOut[] } {
  if (servers === undefined) return { entries: [], problems: [] };
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers))
    return {
      entries: [],
      problems: [
        { what, why: 'Its MCP servers are not a table of servers, so none of them load.' },
      ],
    };
  // Read from the parsed text's own keys, so a name such as `__proto__` is an entry like any other.
  const entries: YourMcpEntry[] = [];
  for (const name of Object.keys(servers)) {
    if (name === '') continue;
    const value: unknown = Object.getOwnPropertyDescriptor(servers, name)?.value;
    const parsed = parse(value);
    entries.push({
      key: yourMcpServerKey(source, name),
      name,
      claudeName: null,
      source,
      pluginId: null,
      declared: parsed.declared,
      configHash: parsed.declared === null ? null : yourMcpConfigHash(source, parsed.declared),
      enabledInSource: parsed.enabled,
      refusal: refusalOf(name, value, source, parsed),
    });
  }
  return { entries, problems: [] };
}
