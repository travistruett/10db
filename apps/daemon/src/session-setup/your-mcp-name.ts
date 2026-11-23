/**
 * A plugin's server as Claude Code names it in a session: `plugin_<plugin>_<server>`, the plugin being the
 * id before `@`, with anything outside letters, digits, `_` and `-` as `_`.
 */
export function yourMcpName(pluginId: string, serverName: string): string {
  const plugin = pluginId.split('@')[0] ?? pluginId;
  const clean = (text: string): string => text.replace(/[^A-Za-z0-9_-]/g, '_');
  return `plugin_${clean(plugin)}_${clean(serverName)}`;
}

/**
 * A plugin's server as Claude Code registers it, `plugin:<plugin>:<server>`, unchanged. Claude Code files an
 * MCP sign-in under the server's registered name, so a session that registers it under any other name finds
 * the builder signed out. Its tools are still `mcp__plugin_<plugin>_<server>__*`.
 */
export function claudePluginServerName(pluginId: string, serverName: string): string {
  const plugin = pluginId.split('@')[0] ?? pluginId;
  return `plugin:${plugin}:${serverName}`;
}
