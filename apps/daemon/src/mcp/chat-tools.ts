import {
  builderToolList,
  ChatToolName,
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
const CHAT_NOTES: Partial<Record<string, string>> = {
  remove_task: 'On a task this chat did not file, the builder is asked first, and may keep it.',
  retire_knowledge: 'The builder is asked first, every time.',
  withdraw_knowledge: 'The builder is asked first, every time.',
  supersede_knowledge: 'The builder is asked first, every time.',
};

/**
 * What the git tools tell the agent. They run only while this turn holds Your folder, never on a `10db/`
 * branch, and the daemon runs git for them with the project's hooks and filters off.
 */
const GIT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  make_branch:
    'Create a branch at the current commit and switch to it, keeping the changes in the folder (nothing is committed). Names under 10db/, or starting with - or +, are refused.',
  switch_branch:
    "Switch Your folder to an existing local branch, carrying changes git can carry and refusing ones it would overwrite. 10db's own branches (10db/…) are refused.",
  pull: "Fetch the current branch's upstream on origin and fast-forward to it. A diverged branch, a detached HEAD or changes in the way are reported and nothing moves.",
  commit_changes:
    "Commit changes in Your folder with the builder's identity. With paths, only those files are committed (other staged files stay staged); with none, everything that changed is. Git hooks do not run here, and the message is taken as text. Commit only when the builder asks.",
  push_branch:
    "Push the current branch to origin under its own name. Never forced; a branch that moved on the remote is reported, not overwritten. 10db's branches (10db/…) are refused. A judge sees each call; push only when the builder asks.",
  open_pull_request:
    'Open a pull request from the current branch, which must be pushed at its current commit. base defaults to main. A judge sees each call; open one only when the builder asks.',
  merge_pull_request:
    "Merge this project's pull request by its number (squash). Pull requests from 10db's own branches are refused. A judge sees each call; merge only when the builder asked for that merge.",
};

export const CHAT_TOOL_DESCRIPTIONS: Readonly<Record<ChatToolName, string>> = Object.fromEntries(
  Object.values(ChatToolName).map((name) => {
    if (name === ChatToolName.SetTitle)
      return [
        name,
        'Name this session in at most 28 characters, in sentence case, with no trailing period. Call it once, after your first reply.',
      ];
    if (name === ChatToolName.WriteBrief)
      return [
        name,
        'Write the brief for a task that does the work agreed in this chat: its title, the brief itself, the areas it works in and its acceptance criteria. Call it only when asked for the brief; it changes nothing.',
      ];
    const git = GIT_DESCRIPTIONS[name];
    if (git !== undefined) return [name, git];
    const words = BUILDER_DESCRIPTIONS.get(name) ?? '';
    const note = CHAT_NOTES[name];
    return [
      name,
      `${words} This chat's tools act in its own project: leave projectId out.${note === undefined ? '' : ` ${note}`}`,
    ];
  }),
) as Readonly<Record<ChatToolName, string>>;
