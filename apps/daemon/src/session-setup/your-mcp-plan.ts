import {
  YourMcpServerState,
  YourMcpSource,
  type TrustSwitches,
  type YourMcpServerKey,
} from '@10db/contracts';
import {
  expandFrom,
  YourMcpExpandError,
  type ClaudeOAuth,
  type CodexServerExtras,
} from '../sessions';
import type { LeftOut } from './left-out';
import type { DeclaredYourServer, YourMcpEntry } from './your-mcp-entry';

/**
 * The names Codex gives a stdio server from its own environment before the entry's `env_vars` and `env`
 * (`DEFAULT_ENV_VARS`, `codex-rs/rmcp-client/src/utils.rs` at `rust-v0.167.0`; live check L5b).
 */
export const CODEX_MCP_BASE_ENV = [
  'HOME',
  'LOGNAME',
  'PATH',
  'SHELL',
  'USER',
  '__CF_USER_TEXT_ENCODING',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TZ',
] as const;

/** A stdio server as one session runs it, expanded. */
export interface YourStdioPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  /** The whole environment the server gets. */
  readonly env: Readonly<Record<string, string>>;
  /** The variables the entry itself set, as against those the login environment brought. */
  readonly declaredEnv: readonly string[];
  readonly codex: CodexServerExtras;
}

/** An http or sse server as one session connects to it, expanded. */
export interface YourRemotePlan {
  /** The declaration the server was planned from. */
  readonly key: YourMcpServerKey;
  /** The name a Claude session registers it under, when not the plan's own (`YourMcpEntry.claudeName`). */
  readonly claudeName: string | null;
  readonly type: 'http' | 'sse';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>> | null;
  /** Claude Code's `oauth` block, as the approval covered it. */
  readonly oauth: ClaudeOAuth | null;
  readonly codex: CodexServerExtras;
}

/** One session's servers of the builder's, by name, and what was left out and why. */
export interface YourMcpPlan {
  readonly stdio: Readonly<Record<string, YourStdioPlan>>;
  readonly remote: Readonly<Record<string, YourRemotePlan>>;
  readonly leftOut: readonly LeftOut[];
  /** Whether the session takes the builder's claude.ai connectors: the same switch as the servers. */
  readonly connectorsOn: boolean;
}

const SOURCE_ORDER: Readonly<Record<YourMcpSource, number>> = {
  [YourMcpSource.ClaudeJson]: 0,
  [YourMcpSource.CodexConfig]: 1,
  [YourMcpSource.Plugin]: 2,
};

function sourceLabel(entry: YourMcpEntry): string {
  switch (entry.source) {
    case YourMcpSource.ClaudeJson:
      return '~/.claude.json';
    case YourMcpSource.CodexConfig:
      return '~/.codex/config.toml';
    case YourMcpSource.Plugin:
      return `the ${entry.pluginId ?? ''} plugin`;
  }
}

/** Where a server stands against the builder's approvals. A plugin's needs none. */
export function serverState(
  entry: YourMcpEntry,
  approvals: ReadonlyMap<YourMcpServerKey, string>,
): YourMcpServerState {
  if (entry.refusal !== null || entry.configHash === null) return YourMcpServerState.LeftOut;
  if (entry.source === YourMcpSource.Plugin) return YourMcpServerState.Approved;
  const approved = approvals.get(entry.key);
  if (approved === undefined) return YourMcpServerState.New;
  return approved === entry.configHash ? YourMcpServerState.Approved : YourMcpServerState.Changed;
}

/** A plan step that leaves its server out, naming a field or a variable and never a value. */
class LeftOutError extends Error {
  override readonly name = 'LeftOutError';
}

const unset = (what: string, variable: string): LeftOutError =>
  new LeftOutError(`${what} ${variable}, which is not set in your login environment`);

function expanded(value: string, env: Readonly<Record<string, string>>, field: string): string {
  try {
    return expandFrom(value, env);
  } catch (error) {
    if (!(error instanceof YourMcpExpandError)) throw error;
    if (error.variable === null)
      throw new LeftOutError(`its ${field} holds a "\${" that names no variable`);
    throw unset(`its ${field} uses`, `\${${error.variable}}`);
  }
}

const own = (env: Readonly<Record<string, string>>, name: string): string | undefined =>
  Object.hasOwn(env, name) ? env[name] : undefined;

function stdioPlan(
  entry: YourMcpEntry,
  server: Extract<DeclaredYourServer, { transport: 'stdio' }>,
  loginEnv: Readonly<Record<string, string>>,
): YourStdioPlan {
  const declared: Record<string, string> = {};
  let base: Record<string, string>;
  if (entry.source === YourMcpSource.CodexConfig) {
    base = {};
    for (const name of CODEX_MCP_BASE_ENV) {
      const value = own(loginEnv, name);
      if (value !== undefined) base[name] = value;
    }
    // Codex skips an unset `env_vars` name.
    for (const name of server.envVars) {
      const value = own(loginEnv, name);
      if (value !== undefined) declared[name] = value;
    }
    Object.assign(declared, server.env);
  } else {
    base = { ...loginEnv };
    for (const [name, value] of Object.entries(server.env))
      declared[name] = expanded(value, loginEnv, `env ${name}`);
  }
  return {
    command: server.command,
    args: [...server.args],
    cwd: server.cwd,
    env: { ...base, ...declared },
    declaredEnv: Object.keys(declared).sort(),
    codex: server.codex,
  };
}

function remotePlan(
  entry: YourMcpEntry,
  server: Extract<DeclaredYourServer, { transport: 'http' | 'sse' }>,
  loginEnv: Readonly<Record<string, string>>,
): YourRemotePlan {
  const headers: Record<string, string> = {};
  let url = server.url;
  if (entry.source === YourMcpSource.CodexConfig) {
    Object.assign(headers, server.headers);
    for (const [header, variable] of Object.entries(server.envHeaders)) {
      const value = own(loginEnv, variable);
      if (value !== undefined) headers[header] = value;
    }
    if (server.bearerTokenVar !== null) {
      const token = own(loginEnv, server.bearerTokenVar);
      if (token === undefined) throw unset('its bearer_token_env_var names', server.bearerTokenVar);
      headers['Authorization'] = `Bearer ${token}`;
    }
  } else {
    url = expanded(server.url, loginEnv, 'url');
    for (const [header, value] of Object.entries(server.headers))
      headers[header] = expanded(value, loginEnv, `header ${header}`);
  }
  return {
    key: entry.key,
    claudeName: entry.claudeName,
    type: server.transport,
    url,
    headers: Object.keys(headers).length === 0 ? null : headers,
    oauth: server.oauth,
    codex: server.codex,
  };
}

/** A host on this Mac: where a lane allowed to bind local ports could listen first. */
function isLoopback(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host === 'localhost.' ||
    host.endsWith('.localhost') ||
    host.endsWith('.localhost.') ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host === '[::]' ||
    host.startsWith('[::ffff:7f') ||
    host === '[::ffff:0:0]'
  );
}

const PLAIN_SEGMENT = /^[A-Za-z0-9._-]{1,24}$/;
const MAX_SEGMENTS = 4;

/** A long segment mixing letters and digits reads as a token, not a word like `mcp` or `v1`. */
const looksLikeToken = (segment: string): boolean =>
  segment.length >= 12 && /[A-Za-z]/.test(segment) && /\d/.test(segment);

/**
 * Whether a remote server sends something a lane could read off a port it listens on: headers, or a secret
 * in its URL: userinfo, a query, a fragment, a `${}` reference that expands into it, or a path that isn't a
 * short plain endpoint such as `/mcp` or `/v1/sse` (a token can sit in a path segment).
 */
function sendsCredentials(
  declaredUrl: string,
  planned: { readonly url: string; readonly headers: object | null },
): boolean {
  if (planned.headers !== null || declaredUrl.includes('${')) return true;
  try {
    const parsed = new URL(planned.url);
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    )
      return true;
    const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
    return (
      segments.length > MAX_SEGMENTS ||
      !segments.every((s) => PLAIN_SEGMENT.test(s) && !looksLikeToken(s))
    );
  } catch {
    return true;
  }
}

/**
 * One session's servers from the builder's files and plugins, by the trust switches, the approvals and the
 * login environment. A session's set is fixed when it starts. The first rule that matches an entry decides it.
 */
export function planYourMcp(args: {
  readonly entries: readonly YourMcpEntry[];
  readonly switches: TrustSwitches;
  readonly approvals: ReadonlyMap<YourMcpServerKey, string>;
  readonly projectServerNames: readonly string[];
  readonly loginEnv: Readonly<Record<string, string>>;
  /** Whether the session's sandbox lets commands bind local ports: the project's loopback switch. */
  readonly localBinding: boolean;
}): YourMcpPlan {
  const stdio: Record<string, YourStdioPlan> = {};
  const remote: Record<string, YourRemotePlan> = {};
  const leftOut: LeftOut[] = [];
  if (!args.switches.yourMcpServers) return { stdio, remote, leftOut, connectorsOn: false };
  const taken = new Map<string, YourMcpEntry>();
  const project = new Set(args.projectServerNames);
  const ordered = [...args.entries].sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]);
  const outcomes = new Map<YourMcpEntry, string>();
  for (const entry of ordered) {
    const why = decide(entry);
    if (why !== null) outcomes.set(entry, why);
  }
  // Notes keep the order the files list the servers in.
  for (const entry of args.entries) {
    const why = outcomes.get(entry);
    if (why !== undefined)
      leftOut.push({ what: `your MCP server ${entry.name} (${sourceLabel(entry)})`, why });
  }
  return { stdio, remote, leftOut, connectorsOn: true };

  /** Plans the entry and returns null, or returns why it is left out; null too for one switched off. */
  function decide(entry: YourMcpEntry): string | null {
    if (entry.refusal !== null) return entry.refusal;
    const declared = entry.declared;
    if (declared === null) return "It can't be read.";
    const switched = Object.hasOwn(args.switches.mcpServers, entry.key)
      ? args.switches.mcpServers[entry.key]
      : undefined;
    if (!(switched ?? entry.enabledInSource)) return null;
    const state = serverState(entry, args.approvals);
    if (state === YourMcpServerState.New) return 'waiting for your approval in Settings › Trust';
    if (state === YourMcpServerState.Changed)
      return 'changed since you approved it; approve it again in Settings › Trust';
    if (project.has(entry.name)) return "the project's .mcp.json declares a server with this name";
    const earlier = taken.get(entry.name);
    if (earlier !== undefined)
      return `a server named ${entry.name} is already in this session from ${sourceLabel(earlier)}`;
    try {
      if (declared.transport === 'stdio') {
        stdio[entry.name] = stdioPlan(entry, declared, args.loginEnv);
      } else {
        const planned = remotePlan(entry, declared, args.loginEnv);
        if (args.localBinding && isLoopback(planned.url) && sendsCredentials(declared.url, planned))
          return "it sends its headers to this Mac, where a project that lets its lanes bind local ports may have commands listening; turn that project's loopback off to use it";
        remote[entry.name] = planned;
      }
    } catch (error) {
      if (error instanceof LeftOutError) return error.message;
      throw error;
    }
    taken.set(entry.name, entry);
    return null;
  }
}
