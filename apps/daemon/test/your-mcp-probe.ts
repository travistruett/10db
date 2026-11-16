import { homedir } from 'node:os';

/** The token the probe server's declared env holds, which no lane may read from the process. */
export const PROBE_TOKEN = 'sk-canary-your-mcp';
/** The argument marker the probe server starts with, which no lane may read from the process list. */
export const PROBE_ARG = '--marker=arg-canary-your-mcp';

/**
 * A stdio MCP server standing in for one of the builder's: one tool, `check`, which reports its pid, whether
 * it got its declared token and whether it could read a canary in the builder's home. Newline-delimited
 * JSON-RPC, as Claude Code and Codex speak it over stdio. It takes the canary's path as its first argument.
 */
export const YOUR_MCP_PROBE_SERVER = `
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const canary = process.argv[2];
const attempt = (fn) => { try { fn(); return 'ok'; } catch { return 'denied'; } };
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === 'initialize') {
    send({ id: request.id, result: {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'probe', version: '1.0.0' },
    } });
  } else if (request.method === 'tools/list') {
    send({ id: request.id, result: { tools: [{
      name: 'check',
      description: 'Reports what this server could reach.',
      inputSchema: { type: 'object', properties: {} },
    }] } });
  } else if (request.method === 'tools/call') {
    const text = [
      'pid=' + process.pid,
      'token=' + (process.env.TOKEN === undefined ? 'unset' : 'set'),
      'server-read-home-canary=' + attempt(() => readFileSync(canary)),
    ].join(' ');
    send({ id: request.id, result: { content: [{ type: 'text', text }] } });
  } else {
    send({ id: request.id, error: { code: -32601, message: 'method not found' } });
  }
}
`;

/** The file the lane's write probe tries to make in the files root; a test removes it if it was made. */
export const LANE_WROTE = 'lane-wrote-your-mcp';

/** What `laneProbeScript` reaches for beyond the files root. */
export interface LaneProbeTargets {
  /** The real home path, never `~`: the keychain lines name a file under it. */
  readonly home: string;
  /** Token files a lane must not read; a test plants a canary in each. At least one, or `TOKEN_FILE` prints nothing. */
  readonly tokenFiles: readonly string[];
}

/**
 * Shell probes for a lane, one line each, naming what the lane's own commands could learn of an unsandboxed
 * server: its environment and arguments from the process list, its sealed env file, the builder's
 * `~/.claude.json` and `~/.codex/config.toml`, a write into the files root, the login keychain's folder and its
 * Claude and Codex entries (attribute lookups, never `-w` or `-g`), and each token file. A count of matches or
 * `ok` is printed, never a value. `denied` or a zero is what holds.
 */
export function laneProbeScript(
  filesRoot: string,
  targets: LaneProbeTargets = { home: homedir(), tokenFiles: [] },
): string {
  const { home } = targets;
  const keychain = `${home}/Library/Keychains/login.keychain-db`;
  const lookup = (service: string): string =>
    `/usr/bin/security find-generic-password -s '${service}' '${keychain}' >/dev/null 2>&1`;
  return [
    // Whether ps runs at all in the sandbox: it is refused outright, which is what keeps process info closed.
    `[ "$(/bin/ps -o pid= -p $$ 2>/dev/null | wc -l | tr -d ' ')" = 1 ] && echo PS_RAN=ok || echo PS_RAN=denied`,
    `echo "PS_ENV=$(/bin/ps -Aww -E -o command= 2>/dev/null | grep -c 'sk-canary-your-mc[p]')"`,
    `echo "PS_ARGS=$(/bin/ps -Aww -o command= 2>/dev/null | grep -c 'arg-canary-your-mc[p]')"`,
    `cat '${filesRoot}'/10db-ymcp-*.sh >/dev/null 2>&1 && echo ENV_FILE=ok || echo ENV_FILE=denied`,
    `cat '${home}/.claude.json' >/dev/null 2>&1 && echo CLAUDE_JSON=ok || echo CLAUDE_JSON=denied`,
    `cat '${home}/.codex/config.toml' >/dev/null 2>&1 && echo CODEX_TOML=ok || echo CODEX_TOML=denied`,
    `touch '${filesRoot}/${LANE_WROTE}' 2>/dev/null && echo FILES_WRITE=ok || echo FILES_WRITE=denied`,
    `ls '${home}/Library/Keychains' >/dev/null 2>&1 && echo KEYCHAINS=ok || echo KEYCHAINS=denied`,
    `${lookup('Claude Code-credentials')} && echo SECURITY_CLAUDE=ok || echo SECURITY_CLAUDE=denied`,
    `${lookup('Codex MCP Credentials')} && echo SECURITY_CODEX=ok || echo SECURITY_CODEX=denied`,
    ...targets.tokenFiles.map(
      (file) =>
        `head -c1 '${file}' >/dev/null 2>&1 && echo TOKEN_FILE=ok || echo TOKEN_FILE=denied`,
    ),
    '',
  ].join('\n');
}

/** What the lane's probes print when nothing leaked; `PS_RAN` is `ok` or `denied`, and a missing line fails. */
export const PS_RAN = /PS_RAN=(?:ok|denied)/;

/** What the lane's probes print when nothing leaked. */
export const PROBES_HELD: readonly string[] = [
  'PS_ENV=0',
  'PS_ARGS=0',
  'ENV_FILE=denied',
  'CLAUDE_JSON=denied',
  'CODEX_TOML=denied',
  'FILES_WRITE=denied',
  'KEYCHAINS=denied',
  'SECURITY_CLAUDE=denied',
  'SECURITY_CODEX=denied',
  'TOKEN_FILE=denied',
];

/** The builder's signed-in OAuth server a live row connects: its name and its https address. */
export interface LiveOAuthServer {
  readonly name: string;
  readonly url: string;
}

/**
 * Reads `TENDB_LIVE_OAUTH_SERVER`: `<name>` for Linear's server under that name, or `<name>=<https url>`. The
 * name is part of the keychain key Claude Code stores a sign-in under, so it must be the one the builder
 * signed in under.
 */
export function liveOAuthServer(value: string | undefined): LiveOAuthServer {
  if (value === undefined || value === '') throw new Error('TENDB_LIVE_OAUTH_SERVER is not set');
  const [name = '', url = 'https://mcp.linear.app/mcp'] = value.split('=');
  if (name === '' || !url.startsWith('https://'))
    throw new Error('TENDB_LIVE_OAUTH_SERVER is <name> or <name>=<https url>');
  return { name, url };
}
