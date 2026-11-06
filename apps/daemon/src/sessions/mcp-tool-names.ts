/** How long a card waits for the servers' tool lists before it falls back to what init listed. */
const TOOL_LIST_WAIT_MS = 5000;

interface McpStatus {
  readonly name: string;
  readonly status: string;
  readonly tools?: readonly { readonly name: string }[];
}

/**
 * The full tool names (`mcp__<server>__<tool>`) the connected MCP servers list in `mcpServerStatus()`.
 * A server that is not connected lists none, and a name already in full form is kept as it is.
 */
export function mcpStatusToolNames(servers: readonly McpStatus[]): string[] {
  return servers.flatMap((server) =>
    server.status !== 'connected'
      ? []
      : (server.tools ?? []).map((tool) =>
          tool.name.startsWith('mcp__')
            ? tool.name
            : `mcp__${server.name.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool.name}`,
        ),
  );
}

/**
 * The tool names a session has now: what its init listed plus what the connected MCP servers list. The
 * repo's servers are registered after init, so init lacks their tools. When the servers do not answer in
 * time, or fail, it is what init listed: fewer names only ever means fewer tools offered a server rule.
 */
export async function currentToolNames(
  status: () => Promise<readonly McpStatus[]>,
  initTools: readonly string[],
  onError: (error: unknown) => void,
): Promise<readonly string[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const servers = await Promise.race([
      status(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('mcp server status timed out'));
        }, TOOL_LIST_WAIT_MS);
      }),
    ]);
    return [...new Set([...initTools, ...mcpStatusToolNames(servers)])];
  } catch (error) {
    onError(error);
    return initTools;
  } finally {
    clearTimeout(timer);
  }
}
