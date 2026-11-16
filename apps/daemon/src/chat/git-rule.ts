import { ChatToolName } from '@10db/contracts';

/**
 * The chat tools that reach GitHub: a push and a pull request send the builder's work out, a merge writes to a
 * shared branch. None is in `allowedTools`, so the session's judge sees each call; the hook's own answer is a
 * bare allow where a judge runs and a question on the rules floor.
 */
export const JUDGED_CHAT_TOOLS: ReadonlySet<string> = new Set([
  ChatToolName.PushBranch,
  ChatToolName.OpenPullRequest,
  ChatToolName.MergePullRequest,
]);

/** What the rules floor asks the builder when a chat reaches for one of them. */
export const JUDGED_CHAT_TOOL_ASK =
  'This tool sends work to GitHub or merges it, and no judge is watching this chat, so the builder decides.';

/**
 * What a chat's shell is refused with when it writes git or GitHub: the daemon does those through the chat's
 * tools, with hooks off, on pinned remotes, and judged where they send data out. Reads (`status`, `diff`, `log`,
 * `show`) run in the shell as they do for a lane.
 */
export const CHAT_GIT_REFUSAL =
  'A chat changes git and GitHub through its tools, not its shell: make_branch, switch_branch, pull, commit_changes, push_branch, open_pull_request and merge_pull_request. Reading (git status, diff, log, show) runs here.';
