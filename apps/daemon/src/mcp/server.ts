import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  ChatId,
  ChatToolInputs,
  ChatToolName,
  CheckDesignInput,
  ConversationOwnerKind,
  DomainError,
  McpToolInputs,
  McpToolName,
  ShapeToolInputs,
  ShapeToolName,
  type ConversationId,
  type ProjectId,
  type SessionId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getConversation,
  getLiveSessionByTokenHash,
  isLaneSession,
  type SessionRow,
} from '@10db/db';
import { z } from 'zod';
import { GitTrustError } from '../git';
import { ParkedError } from '../inbox';
import { hashToken } from './tokens';
import { ClaimWaits } from './claim-wait';
import { CHAT_TOOL_DESCRIPTIONS } from './chat-tools';
import { SHAPE_TOOL_DESCRIPTIONS } from './shape-tools';
import { checkDesignTool, offersDesignCheck } from './design-check-tool';
import { ToolImages } from './tool-images';
import { createToolHandlers, TOOL_DESCRIPTIONS, type McpDeps } from './tools';

function errorText(error: unknown, deps: McpDeps, tool: string, args: unknown): string {
  // The card stays open; its answer reaches the next session's prompt, so a retry would open a second card.
  if (error instanceof ParkedError)
    return '10db parked this session until the builder answers. Do not ask again: the answer arrives in the prompt of the session that resumes this work. End your turn now.';
  if (error instanceof DomainError) return error.message;
  // The builder already has a card about it, and only the builder can put the checkout right.
  if (error instanceof GitTrustError)
    return `${error.message}. The builder has a card about it. Don't work around it: end your turn now.`;
  if (error instanceof z.ZodError)
    return `Invalid input: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  const opId = z.object({ opId: z.string() }).safeParse(args);
  deps.log.error(
    { err: error, tool, opId: opId.success ? opId.data.opId : null },
    'mcp tool failed',
  );
  return `The ${tool} call failed inside 10db and was not completed. Check that your input is valid for the current repository state; if it keeps failing, report the problem to the builder with ask_human.`;
}

/** A tool as the endpoint registers it: its name, words, input schema and what running it does. */
interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType;
  run(input: unknown): Promise<unknown>;
}

function laneTools(
  deps: McpDeps,
  sessionId: SessionId,
  workstreamId: WorkstreamId,
  claimWaits: ClaimWaits,
): RegisteredTool[] {
  const handlers = createToolHandlers(deps, sessionId, workstreamId, claimWaits);
  const tools: RegisteredTool[] = Object.values(McpToolName).map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    schema: McpToolInputs[name],
    // Each handler takes its own tool's parsed input; the registry pairs them by name.
    run: (input) => (handlers[name] as (input: unknown) => Promise<unknown>)(input),
  }));
  // A task with an approved mock-up is also offered the tool that shows it beside the app.
  if (deps.pictures !== undefined && offersDesignCheck(deps.state.db, workstreamId)) {
    const check = checkDesignTool({ state: deps.state, pictures: deps.pictures }, workstreamId);
    tools.push({
      name: check.name,
      description: check.description,
      schema: check.schema,
      run: (input) => check.run(CheckDesignInput.parse(input)),
    });
  }
  return tools;
}

/** The chat a conversation's session belongs to. */
interface ChatSession {
  readonly chatId: ChatId;
  readonly conversationId: ConversationId;
  readonly projectId: ProjectId;
}

/** Plan's tools, offered to every chat's session: a chat with no plan yet makes one by `propose_plan`. */
function shapeTools(
  deps: McpDeps,
  sessionId: SessionId,
  chat: ChatSession,
): RegisteredTool[] | null {
  if (!deps.shapeTools) return null;
  const handlers = deps.shapeTools({ sessionId, ...chat });
  const tools = Object.values(ShapeToolName).flatMap((name) => {
    const handler = handlers[name] as ((input: unknown) => Promise<unknown>) | undefined;
    return handler
      ? [
          {
            name,
            description: SHAPE_TOOL_DESCRIPTIONS[name],
            schema: ShapeToolInputs[name],
            run: handler,
          },
        ]
      : [];
  });
  return tools.length > 0 ? tools : null;
}

/** The tools of a chat's session, or null when 10db was given none to offer. */
function chatTools(deps: McpDeps, session: SessionRow, chat: ChatSession): RegisteredTool[] | null {
  if (!deps.chatTools) return null;
  const handlers = deps.chatTools({ sessionId: session.id, ...chat });
  return Object.values(ChatToolName).map((name) => ({
    name,
    description: CHAT_TOOL_DESCRIPTIONS[name],
    schema: ChatToolInputs[name],
    run: handlers[name],
  }));
}

/** A chat's session's tools: the chat's, and Plan's beside them whether or not the chat has a plan yet. */
function conversationTools(deps: McpDeps, session: SessionRow): RegisteredTool[] | null {
  if (session.conversationId === null) return null;
  const conv = getConversation(deps.state.db, session.conversationId);
  if (conv.ownerKind !== ConversationOwnerKind.Chat) return null;
  const chat: ChatSession = {
    // The owner id of a chat's conversation is a ChatId; parsed, as text read from the database.
    chatId: ChatId.parse(conv.ownerId),
    conversationId: conv.id,
    projectId: conv.projectId,
  };
  const own = chatTools(deps, session, chat);
  if (own === null) return null;
  return [...own, ...(shapeTools(deps, session.id, chat) ?? [])];
}

/** Stateless streamable-HTTP MCP endpoint; the bearer token identifies the calling session. */
export function createMcpHandler(deps: McpDeps): (req: Request) => Promise<Response> {
  // Every session's claim waits in one place, so a deadlock check sees the waits of all of them.
  const claimWaits = deps.claimWaits ?? new ClaimWaits();
  return async (req) => {
    const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
    const session = token ? getLiveSessionByTokenHash(deps.state.db, hashToken(token)) : undefined;
    if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

    // A session's tool set comes from its row: a lane's tools for a workstream. Any other session is a
    // chat's: the chat's tools held to its project, and Plan's tools beside them, plan or not (a chat with
    // none is refused the tools that need rows). A chat's session holds no lane, claim or area, so it never
    // gets a lane's tool.
    const tools = isLaneSession(session)
      ? laneTools(deps, session.id, session.workstreamId, claimWaits)
      : conversationTools(deps, session);
    if (tools === null) return Response.json({ error: 'unauthorized' }, { status: 401 });

    const server = new McpServer({ name: '10db', version: '0.1.0' });
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.schema },
        async (args: unknown) => {
          try {
            const output = await tool.run(tool.schema.parse(args));
            // A tool whose result is pictures answers image blocks, which the session sees as its result.
            if (output instanceof ToolImages)
              return {
                content: [
                  { type: 'text' as const, text: output.text },
                  ...output.images.map((image) => ({
                    type: 'image' as const,
                    data: image.data,
                    mimeType: image.mediaType,
                  })),
                ],
              };
            return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
          } catch (error) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: errorText(error, deps, tool.name, args) }],
            };
          }
        },
      );
    }
    // No sessionIdGenerator means stateless mode; passing `undefined` explicitly fails exactOptionalPropertyTypes.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  };
}
