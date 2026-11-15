import { createHash } from 'node:crypto';
import type { McpConfigEntry, YourMcpSource } from '@10db/contracts';
import { SENSITIVE_NAME } from '../sessions';
import type { DeclaredYourServer } from './your-mcp-entry';

/** A value that is a URL with a user and password in it. */
const URL_WITH_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i;

/** Whether an env entry holds a secret: named like one, or a URL carrying userinfo. */
const isSecret = (name: string, value: string): boolean =>
  SENSITIVE_NAME.test(name) || URL_WITH_USERINFO.test(value);

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
        isSecret(name, value) ? [name] : [name, value],
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
    .filter(([name, value]) => !isSecret(name, value))
    .map(([name, value]) => ({ name, value }));
}
