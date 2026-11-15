import { createHash } from 'node:crypto';
import type { McpConfigEntry, YourMcpSource } from '@10db/contracts';
import { loadsCode } from '../sandbox';
import { SENSITIVE_NAME } from '../sessions';
import type { DeclaredYourServer } from './your-mcp-entry';

/** Names of programs, commands and sockets: a changed one runs something else, so an approval covers it. */
const NEVER_SECRET = /ASKPASS|_CMD$|_COMMAND$|^SSH_AUTH_SOCK$/i;

/**
 * The value with a URL's userinfo taken out, so a rotated password doesn't ask again but a new host does. Only
 * what the URL parser reports as a user or password goes; a value that doesn't parse is kept as it is.
 */
const withoutUserinfo = (value: string): string => {
  try {
    const url = new URL(value);
    if (url.username === '' && url.password === '') return value;
    return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
};

/** Whether an env name holds a secret: named like one, and never a name that makes a program load code. */
const isSecretName = (name: string): boolean =>
  !loadsCode(name) && !NEVER_SECRET.test(name) && SENSITIVE_NAME.test(name);

const sorted = (values: readonly string[]): string[] => [...values].sort();
const sortedEntries = (map: Readonly<Record<string, string>>): [string, string][] =>
  Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The config as an approval covers it: what runs and where it connects, every env value but a secret-named
 * one, and header names only. A rotated token or header doesn't ask again; a new variable or a changed
 * `PATH` does.
 */
function normalized(source: YourMcpSource, server: DeclaredYourServer): unknown {
  const filters = {
    enabledTools: server.codex.enabledTools === null ? null : sorted(server.codex.enabledTools),
    disabledTools: sorted(server.codex.disabledTools),
  };
  if (server.transport === 'stdio')
    return {
      source,
      transport: server.transport,
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: sortedEntries(server.env).map(([name, value]) =>
        isSecretName(name) ? [name] : [name, withoutUserinfo(value)],
      ),
      envVars: sorted(server.envVars),
      ...filters,
    };
  return {
    source,
    transport: server.transport,
    url: server.url,
    headers: sorted(Object.keys(server.headers)),
    envHeaders: sortedEntries(server.envHeaders),
    bearerTokenVar: server.bearerTokenVar,
    ...filters,
  };
}

/** The SHA-256 hex an approval of one of the builder's servers is keyed on. */
export function yourMcpConfigHash(source: YourMcpSource, server: DeclaredYourServer): string {
  return createHash('sha256')
    .update(JSON.stringify(normalized(source, server)))
    .digest('hex');
}

/** The env entries whose values the hash covers, which Settings shows: every one but a secret-named one. */
export function shownEnvOf(server: DeclaredYourServer): McpConfigEntry[] {
  if (server.transport !== 'stdio') return [];
  return sortedEntries(server.env)
    .filter(([name]) => !isSecretName(name))
    .map(([name, value]) => ({ name, value: withoutUserinfo(value) }));
}
