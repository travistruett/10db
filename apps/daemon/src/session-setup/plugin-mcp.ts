import { YourMcpSource, yourMcpServerKey } from '@10db/contracts';
import { isEqualOrUnder, realOrSelf } from '../sandbox';
import { McpServerName, readRepoConfigFileIn, RepoConfigFileError } from '../sessions';
import {
  parseClaudeEntry,
  refusalOf,
  type DeclaredYourServer,
  type YourMcpEntry,
} from './your-mcp-entry';
import { yourMcpConfigHash } from './your-mcp-hash';
import { claudePluginServerName, yourMcpName } from './your-mcp-name';

/** An installed plugin whose servers are read. */
export interface PluginToRead {
  readonly id: string;
  readonly installPath: string;
}

const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}';
const MANIFEST = '.claude-plugin/plugin.json';

/** `${CLAUDE_PLUGIN_ROOT}` is a path, not a secret, so it is the one expansion allowed before the checks. */
function withRoot(value: unknown, root: string): unknown {
  if (typeof value === 'string') return value.replaceAll(PLUGIN_ROOT, root);
  if (Array.isArray(value)) return value.map((item) => withRoot(item, root));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = withRoot(Object.getOwnPropertyDescriptor(value, key)?.value, root);
    }
    return out;
  }
  return value;
}

function readJson(installPath: string, relative: string): unknown {
  let text: string | null;
  try {
    text = readRepoConfigFileIn(installPath, relative);
  } catch (error) {
    // A link, a file over the cap or one that can't be opened loads nothing; the error quotes no file.
    if (error instanceof RepoConfigFileError) return undefined;
    throw error;
  }
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A `.mcp.json` holds `{ mcpServers: {...} }`, or the servers bare. */
function serversOf(json: unknown): Record<string, unknown> | null {
  if (!isRecord(json)) return null;
  if (!Object.hasOwn(json, 'mcpServers')) return json;
  const wrapped: unknown = Object.getOwnPropertyDescriptor(json, 'mcpServers')?.value;
  return isRecord(wrapped) ? wrapped : null;
}

/** The servers a plugin declares: its `.mcp.json`, and `mcpServers` in its manifest (an object or a path). */
function declaredServers(installPath: string): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  const fromFile = serversOf(readJson(installPath, '.mcp.json'));
  const manifest = readJson(installPath, MANIFEST);
  const inline: unknown = isRecord(manifest)
    ? Object.getOwnPropertyDescriptor(manifest, 'mcpServers')?.value
    : undefined;
  const fromManifest =
    typeof inline === 'string'
      ? serversOf(readJson(installPath, inline))
      : serversOf({ mcpServers: inline });
  for (const found of [fromFile, fromManifest]) {
    if (found === null) continue;
    for (const name of Object.keys(found)) {
      if (!Object.hasOwn(servers, name))
        servers[name] = Object.getOwnPropertyDescriptor(found, name)?.value;
    }
  }
  return servers;
}

/**
 * A plugin's MCP servers as entries. Each is named `plugin_<plugin>_<server>`, so the builder's instructions
 * that name a tool still match, and a Claude session registers it as Claude Code does (`claudeName`), where
 * the builder's sign-in is filed. A plugin is the builder's own install, so its
 * servers need no approval, but they take the same refusals as the builder's files and run through 10db's
 * launch, never as a checkout's.
 */
export function readPluginMcp(
  plugin: PluginToRead,
  laneWritable: readonly string[],
): YourMcpEntry[] {
  const real = realOrSelf(plugin.installPath);
  // Either holds the other: a plugin under a root, or one that has a root inside it, where lane-written
  // files would sit among its own.
  const writable = laneWritable.some((root) => {
    const roots = [root, realOrSelf(root)];
    return [plugin.installPath, real].some((path) =>
      roots.some((r) => isEqualOrUnder(path, r) || isEqualOrUnder(r, path)),
    );
  });
  if (writable) {
    // Nothing inside it is read: an agent could have written any file there.
    return [
      {
        key: yourMcpServerKey(YourMcpSource.Plugin, 'all', plugin.id),
        name: yourMcpName(plugin.id, '').replace(/_$/, ''),
        claudeName: null,
        source: YourMcpSource.Plugin,
        pluginId: plugin.id,
        declared: null,
        configHash: null,
        enabledInSource: true,
        refusal:
          'Its plugin is installed in a folder an agent can write, so none of its MCP servers load.',
      },
    ];
  }
  const entries: YourMcpEntry[] = [];
  const servers = declaredServers(plugin.installPath);
  for (const serverName of Object.keys(servers)) {
    if (serverName === '') continue;
    const raw = withRoot(
      Object.getOwnPropertyDescriptor(servers, serverName)?.value,
      plugin.installPath,
    );
    const parsed = parseClaudeEntry(raw);
    const declared: DeclaredYourServer | null =
      parsed.declared?.transport === 'stdio'
        ? {
            ...parsed.declared,
            env: { ...parsed.declared.env, CLAUDE_PLUGIN_ROOT: plugin.installPath },
          }
        : parsed.declared;
    const name = yourMcpName(plugin.id, serverName);
    entries.push({
      key: yourMcpServerKey(YourMcpSource.Plugin, serverName, plugin.id),
      name,
      claudeName: claudePluginServerName(plugin.id, serverName),
      source: YourMcpSource.Plugin,
      pluginId: plugin.id,
      declared,
      configHash: declared === null ? null : yourMcpConfigHash(YourMcpSource.Plugin, declared),
      enabledInSource: true,
      refusal: McpServerName.safeParse(name).success
        ? refusalOf(name, raw, YourMcpSource.Plugin, parsed)
        : "Its name can't be an MCP server name.",
    });
  }
  return entries;
}
