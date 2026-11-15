/**
 * A plugin's server as Claude Code names it in a session: `plugin_<plugin>_<server>`, the plugin being the
 * id before `@`, with anything outside letters, digits, `_` and `-` as `_`.
 */
export function yourMcpName(pluginId: string, serverName: string): string {
  const plugin = pluginId.split('@')[0] ?? pluginId;
  const clean = (text: string): string => text.replace(/[^A-Za-z0-9_-]/g, '_');
  return `plugin_${clean(plugin)}_${clean(serverName)}`;
}
