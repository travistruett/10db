import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { McpHost } from '@10db/contracts';
import { z } from 'zod';
import { readRepoConfigFile, RepoConfigFileError } from './repo-config-file';

/** 10db's own config directory in a repo. */
const TENDB_DIR = '.10db';
/** The repo file that names the hosts each stdio MCP server may reach; `.mcp.json` has no field for them. */
export const MCP_HOSTS_FILE = `${TENDB_DIR}/mcp-hosts.json`;
const MAX_HOSTS = 64;

const McpHostsFile = z.strictObject({
  servers: z.record(z.string(), z.strictObject({ hosts: z.array(McpHost).max(MAX_HOSTS) })),
});

/** The repo's `.10db/mcp-hosts.json` can't be used as written. The message names the file, and the server and field when there is one. */
export class McpHostsFileError extends Error {
  override readonly name = 'McpHostsFileError';
}

/** True when `.10db` is a link: the file under it would then be read from wherever the link points. */
function dirIsLink(repoPath: string): boolean {
  try {
    return lstatSync(join(repoPath, TENDB_DIR)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The hosts the repo names for each server, sorted and once each, or none when there is no file. An
 * unreadable or invalid file throws, so it is never silently ignored.
 */
export function readMcpHosts(repoPath: string): ReadonlyMap<string, readonly string[]> {
  const path = join(repoPath, MCP_HOSTS_FILE);
  if (dirIsLink(repoPath))
    throw new McpHostsFileError(
      `${path} could not be read (${TENDB_DIR} must be a directory, not a link)`,
    );
  let text: string | null;
  try {
    text = readRepoConfigFile(path);
  } catch (error) {
    if (error instanceof RepoConfigFileError)
      throw new McpHostsFileError(`${path} could not be read (${error.message})`);
    throw error;
  }
  if (text === null) return new Map();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new McpHostsFileError(
      `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        'Fix it, or remove it, so 10db can start sessions in this repo.',
    );
  }
  const parsed = McpHostsFile.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new McpHostsFileError(`${path} is not a valid MCP hosts file: ${issues.join('; ')}`);
  }
  return new Map(
    Object.entries(parsed.data.servers).map(([name, { hosts }]) => [
      name,
      [...new Set(hosts)].sort(),
    ]),
  );
}
