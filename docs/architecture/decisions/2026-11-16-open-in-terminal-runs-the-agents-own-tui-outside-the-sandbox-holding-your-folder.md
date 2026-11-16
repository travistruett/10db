# Open in Terminal runs the agent's own TUI outside the sandbox, holding Your folder

- **Date:** 2026-11-16
- **Amends:** the sessions design spec §7.5 (the script's path and the third choice)

## Decision

A chat opens in the builder's terminal as the agent's own TUI (`claude --resume`, `codex resume`). The terminal
runs outside 10db's sandbox and judge; the agent's own prompts guard it, and the popover says so every time.

- **What still holds.** No key in the script, a command line or the agent's shell, wherever the agent allows it; no
  settings file and no project hook (`--setting-sources ''`; Codex keeps the checkout pinned `untrusted`); only
  approved MCP servers, with the project's still under `srt`; Your folder held for the whole takeover.
- **Keys.** An API-key or gateway account reads its key through Claude Code's `apiKeyHelper` (a Keychain read, never
  an environment value). A Bedrock key is read in the script into the agent's environment under
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. The cost: Claude Code forces default mode under the scrub, so a Bedrock key
  has no auto mode in the terminal. A Claude plan, a Bedrock profile and a Codex plan carry no key.
- **The command.** A pure `takeoverCommand` per adapter makes a `TakeoverCommand`; a pure renderer writes it as a
  self-deleting script (`rm -- "$0"` first, no secret) and a `/bin/sh -c` line for zsh or bash. The daemon opens the
  script with `/usr/bin/open -a Terminal|iTerm`; the webview has no capability.
- **Codex runs as Codex does by default.** 10db's lane-only keys (the `lane` permission profile, no login shell,
  an empty shell environment, disabled apps, plugins and memories, no subagents) are switched back to Codex's
  defaults. Kept: the billing line (`forced_login_method`), the sign-in store and the `untrusted` pin. The shell
  environment excludes `TENDB_MCP_TOKEN_*`, so a header token never reaches a command. Codex gets no skills
  folders, because it has no flag for them; the popover says so.
- **Where the files live.** `<data dir>/takeovers/<conversation id>/`, mode 700, outside the chat's own files (its
  session may read those). Every launch writes a fresh set and never reads one back: the terminal's agent can write
  there.
- **Three choices.** Settings › Sessions picks Terminal, iTerm or Copy the Command, which opens nothing and gives a
  line to paste into any terminal (Ghostty, Warp, kitty). A second window is the banner's Copy Command (the
  daemon also takes a second Open, which the UI doesn't offer): two writers on one session. A clipboard that
  refuses the line leaves it in the banner to copy by hand.
- **The hold.** A takeover keeps Your folder, so tasks, branch cuts, switch-backs and passes wait, each naming "the
  chat ‘X’ in your terminal". A wait keeps its project's delivery slot, so a forgotten Hand Back stalls that
  project's delivery. A closed pass allows Open, with a warning: a commit made in the terminal makes its settle ask.
  The waits stop with 10db and resume at the next start; Hand Back runs 10db's waiting git work before a held
  message's turn.
- **Without a sandbox runtime** (the daemon could not build one) a terminal still opens, with none of the chat's
  servers, plugins or instructions, and the popover and banner say so. Nothing project-owned loads either way.
- **Notes.** What a launch left out is kept with the takeover (display data, read through zod, each note cut at 800
  characters) so the banner shows it after the open's answer is gone.
- **Chats only.** A task's Open in Terminal needs runner work and is a follow-up.
- **No history import.** Hand Back leaves one notice; the agent's own resume carries the terminal's turns.

## Why

- The builder asked for the TUI's own features (plan mode, rewind, TUI-only commands) on the same conversation.
  Embedding a terminal in 10db would make a second writer path and a PTY to keep; the builder's own terminal has
  neither.
- A restriction Claude Code doesn't have needs a reason tied to a hard limit or to 10db's own coordination. The
  limits that apply here are reading secrets and agent-written config loading, which the table above closes; the
  rest is what the agent does by default.
- Keys through a helper keep them out of every process's environment; where the agent offers no helper (a Bedrock
  key) the scrub is the next best, and its cost is named.
- Turned down: a lane-style sandbox for the terminal (it would break the TUI's own shell and defeat the point); one
  fixed terminal app (Ghostty, Warp and kitty have no scripting 10db can trust); watching the terminal process
  (10db can't observe it, so Hand Back trusts the builder).
