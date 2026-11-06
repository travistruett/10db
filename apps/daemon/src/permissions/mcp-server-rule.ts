import type { McpToolGrant } from '@10db/contracts';

/**
 * "Always allow every tool of this approved server": stored as one project rule per tool name the server
 * listed when the card was raised. Each rule's pattern ties it to the server and to the config hash the
 * builder approved, and a call matches only while the session's approved config for that server has the
 * same hash. The hash does not cover the server's tool list, so a tool the server adds later has no rule.
 */

const HASH = /^[0-9a-f]{64}$/;

/** The server name as Claude Code writes it in a tool name: any character outside `[A-Za-z0-9_-]` becomes `_`. */
function toolPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__`;
}

/** The pattern a grant rule carries: the approved config hash, then the server's name. */
export function mcpServerPattern(server: string, configHash: string): string {
  return `${configHash}:${server}`;
}

function parsePattern(pattern: string | null): { server: string; configHash: string } | null {
  if (pattern === null) return null;
  const colon = pattern.indexOf(':');
  if (colon < 0) return null;
  const configHash = pattern.slice(0, colon);
  const server = pattern.slice(colon + 1);
  return HASH.test(configHash) && server !== '' ? { server, configHash } : null;
}

/** Whether the tool name belongs to the server and names a tool (not just the prefix). */
function isToolOf(toolName: string, server: string): boolean {
  const prefix = toolPrefix(server);
  return toolName.startsWith(prefix) && toolName.length > prefix.length;
}

/**
 * The server whose tool this is, among the servers this session runs with an approval. When one name is
 * a prefix of another (`a` and `a__b`) the longer wins, as it is the more specific reading.
 */
function serverOf(toolName: string, approved: Readonly<Record<string, string>>): string | null {
  let found: string | null = null;
  for (const server of Object.keys(approved)) {
    if (!isToolOf(toolName, server)) continue;
    if (found === null || toolPrefix(server).length > toolPrefix(found).length) found = server;
  }
  return found;
}

/**
 * What a card for `toolName` may offer: every tool in `listed` that belongs to the same approved project
 * server, with the config hash that server runs. Null when the call is not a tool of an approved server in
 * this session (Bash, a file, the network, 10db's own tools) or the server did not list it.
 */
export function mcpToolGrant(
  toolName: string,
  listed: readonly string[],
  approved: Readonly<Record<string, string>>,
): McpToolGrant | null {
  const name = serverOf(toolName, approved);
  const configHash = name === null ? undefined : approved[name];
  if (name === null || configHash === undefined) return null;
  const tools = listed.filter((tool) => isToolOf(tool, name) && serverOf(tool, approved) === name);
  return tools.includes(toolName) ? { name, configHash, tools: [...new Set(tools)] } : null;
}

/** The rules an answer stores for a grant: one per tool name that really belongs to the server. */
export function mcpGrantRules(
  grant: McpToolGrant,
): { readonly toolName: string; readonly pattern: string }[] {
  const pattern = mcpServerPattern(grant.name, grant.configHash);
  return grant.tools
    .filter((tool) => isToolOf(tool, grant.name))
    .map((toolName) => ({ toolName, pattern }));
}

/**
 * Whether a grant rule's pattern covers the call: the tool is the named server's, and the session runs
 * that server at the config hash the builder approved. `approved` maps each server to its running hash.
 */
export function mcpGrantCovers(
  toolName: string,
  pattern: string | null,
  approved: Readonly<Record<string, string>> | undefined,
): boolean {
  const grant = parsePattern(pattern);
  if (grant === null || approved === undefined) return false;
  return isToolOf(toolName, grant.server) && approved[grant.server] === grant.configHash;
}
