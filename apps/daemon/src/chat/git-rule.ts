import { JUDGED_OWN_TOOLS } from '../trust';

/**
 * The chat tools that reach GitHub: a push and a pull request send the builder's work out, a merge writes to a
 * shared branch. None is in `allowedTools`, so the session's judge sees each call. The hook's own answer is a bare
 * allow only where 10db's judge runs: Claude's auto mode approves all three unasked, so there and on the rules
 * floor the builder is asked.
 */
export const JUDGED_CHAT_TOOLS: ReadonlySet<string> = JUDGED_OWN_TOOLS;

/** What the builder is asked when a chat reaches for one of them and 10db's judge is not watching it. */
export const JUDGED_CHAT_TOOL_ASK =
  'This tool sends work to GitHub or merges it, and no judge that stops it is watching this chat, so the builder decides.';

/**
 * What a chat's shell is refused with when it writes git or GitHub: the daemon does those through the chat's
 * tools, with hooks off, on pinned remotes, and judged where they send data out. Reads (`status`, `diff`, `log`,
 * `show`) run in the shell as they do for a lane.
 */
export const CHAT_GIT_REFUSAL =
  'A chat changes git and GitHub through its tools, not its shell: make_branch, switch_branch, pull, commit_changes, push_branch, open_pull_request and merge_pull_request. Reading (git status, diff, log, show) runs here.';
