import { BUILDER_INSTRUCTIONS, builderToolList } from '@10db/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  JSONRPCErrorResponseSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { runningDaemon } from '../runtime-files';

const NOT_RUNNING = '10db is not running: open the 10db app and try again';

export interface BuilderBridgeOptions {
  readonly dataDir: string;
  /** How long one forwarded call may take. */
  readonly timeoutMs: number;
}

const Reply = z.union([
  z.object({ error: JSONRPCErrorResponseSchema.shape.error }),
  z.object({ result: CallToolResultSchema }),
]);

function failure(message: string): McpError {
  return new McpError(ErrorCode.InternalError, message);
}

/** Whether `fetch` failed because nothing listens on the port (the daemon stopped since daemon.json was written). */
function refusedConnection(error: unknown): boolean {
  return error instanceof TypeError;
}

/**
 * The stdio side of the builder's MCP endpoint. A client starts it once per session, so it
 * answers initialize and the tool list itself, from the same definitions the daemon serves, and
 * works before 10db is open. Only a tool call reaches the daemon: one stateless POST that carries
 * the UI token, read from the data dir for that call alone. Every failure is an McpError, which
 * the SDK sends back with the request's id.
 */
export function createBuilderBridge(options: BuilderBridgeOptions): McpServer {
  const mcp = new McpServer(
    { name: '10db-builder', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: BUILDER_INSTRUCTIONS },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: builderToolList() }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const daemon = runningDaemon(options.dataDir);
    if (daemon === null) throw failure(NOT_RUNNING);
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${String(daemon.info.port)}/builder/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: request.params,
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw failure(`10db did not answer within ${String(options.timeoutMs / 1000)} seconds`);
      }
      throw failure(
        refusedConnection(error) ? NOT_RUNNING : '10db could not be reached: try again',
      );
    }
    if (response.status === 401) {
      throw failure('10db refused the builder token. It may be restarting: try again in a moment');
    }
    const reply = await response.json().then(
      (body: unknown) => {
        const parsed = Reply.safeParse(body);
        return parsed.success ? parsed.data : null;
      },
      () => null,
    );
    if (reply !== null && 'error' in reply) {
      throw new McpError(reply.error.code, reply.error.message, reply.error.data);
    }
    if (!response.ok) throw failure(`10db answered HTTP ${String(response.status)}`);
    if (reply === null) throw failure("10db's answer could not be read");
    return reply.result;
  });
  return mcp;
}
