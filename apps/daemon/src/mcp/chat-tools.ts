import {
  builderToolList,
  ChatToolName,
  type BuilderToolName,
  type ChatId,
  type ConversationId,
  type ProjectId,
  type SessionId,
} from '@10db/contracts';

// Sessions spec §6.6. A chat's session reaches every builder tool, and `set_title`, on 10db's own
// server by its own token. The tools belong to the chat module, which hands the server its handlers.

/** A handler per chat tool, each taking its tool's parsed input. */
export type ChatToolHandlers = Readonly<Record<ChatToolName, (input: unknown) => Promise<unknown>>>;

/** Builds the handlers for one chat's session. */
export type ChatToolsFor = (session: {
  readonly sessionId: SessionId;
  readonly conversationId: ConversationId;
  readonly chatId: ChatId;
  readonly projectId: ProjectId;
}) => ChatToolHandlers;

const BUILDER_DESCRIPTIONS = new Map<string, string>(
  builderToolList().map((tool) => [tool.name, tool.description]),
);

/** What a chat's agent reads about each tool: the builder's words, held to the chat's project. */
const CHAT_NOTES: Partial<Record<BuilderToolName, string>> = {
  remove_task: 'On a task this chat did not file, the builder is asked first, and may keep it.',
  retire_knowledge: 'The builder is asked first, every time.',
  withdraw_knowledge: 'The builder is asked first, every time.',
  supersede_knowledge: 'The builder is asked first, every time.',
};

export const CHAT_TOOL_DESCRIPTIONS: Readonly<Record<ChatToolName, string>> = Object.fromEntries(
  Object.values(ChatToolName).map((name) => {
    if (name === ChatToolName.SetTitle)
      return [
        name,
        'Name this session in at most 28 characters, in sentence case, with no trailing period. Call it once, after your first reply.',
      ];
    const words = BUILDER_DESCRIPTIONS.get(name) ?? '';
    const note = CHAT_NOTES[name];
    return [
      name,
      `${words} This chat's tools act in its own project: leave projectId out.${note === undefined ? '' : ` ${note}`}`,
    ];
  }),
) as Readonly<Record<ChatToolName, string>>;
