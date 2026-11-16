/**
 * What a chat's shell is refused with when it writes git or GitHub: the daemon does those through the chat's
 * tools, with hooks off, on pinned remotes, and judged where they send data out. Reads (`status`, `diff`, `log`,
 * `show`) run in the shell as they do for a lane.
 */
export const CHAT_GIT_REFUSAL =
  'A chat changes git and GitHub through its tools, not its shell: make_branch, switch_branch, pull, commit_changes, push_branch, open_pull_request and merge_pull_request. Reading (git status, diff, log, show) runs here.';
