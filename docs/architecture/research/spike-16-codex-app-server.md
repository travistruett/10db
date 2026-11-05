# Spike 16: Whether a project can run on `codex app-server` and a ChatGPT plan

- **Status:** VERIFIED for what the design relies on, on a local fake model, plus one real turn on the account. Not
  verified: a token refresh with lanes running, a real hard limit, and 10db's real lane profile with a real toolchain.
- **Date:** 2026-11-05
- **Versions:** Codex 0.154.0 (`codex app-server --stdio --strict-config`), macOS 27.2
- **Method:** a throwaway client over stdio JSON-RPC. Hooks, the sandbox, MCP, resume and limits ran on real Codex
  against a local stand-in for the Responses API, through a custom `model_providers` entry, with no login and no spend.
  Then one turn on `gpt-5.6-sol` at low effort on the real account, about 21,000 tokens.
- **Design:** `docs/superpowers/specs/2026-11-05-10db-chatgpt-plan-design.md`

## The real account

| Check                     | Result                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------ |
| Sign-in in its own home   | `codex login` with `CODEX_HOME` set worked, and logging out there left `~/.codex` in |
| `account/read`            | `type: chatgpt`, `planType: pro`, an email. Nothing about the workspace              |
| `account/rateLimits/read` | One limit, `codex`: a primary window of 10080 minutes, no secondary                  |
| Workspace                 | Sign-in asks which to use. The usage read's `accountId`, a UUID, names it            |
| `credits`                 | `hasCredits: false`, balance `0`                                                     |
| `model/list`              | `gpt-6-astra` (default), `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`              |
| Context window            | 258400                                                                               |
| Guard hook, real model    | Fired per command. `echo one` ran, `echo DENYME` was refused, the turn completed     |

## What holds

- **The guard.** A trusted `PreToolUse` hook fires per nested call inside code mode and inside a subagent, as `Bash`
  (`tool_input.command`), `apply_patch` (`tool_input.command` holds the patch) and `mcp__10db__commit`. `deny` stops
  the call and the model is told why. A hook can wait and then answer: an 8 s wait followed by deny, and by allow, held.
- **Isolation.** A `CODEX_HOME` of the account's own loads only the `user` and `system` layers, no MCP servers and no
  hooks. `HOME` set to an empty folder keeps personal skills in `~/.agents` out.
- **Trust.** A `hooks.state` hash written to `config.toml` takes effect in the running app-server, with no restart.
- **Per-lane config.** `thread/start`'s `config` accepts `permissions`, `shell_environment_policy` and `mcp_servers`,
  so nothing per-lane goes on a command line. `--strict-config` accepts 10db's whole template.
- **Credentials and files.** A `deny` entry stops reads of `auth.json`, of `.env` files and of folders. `.git` and
  `.codex` in the checkout are read-only with no rule.
- **Network.** With `features.network_proxy` on, an unlisted host is blocked, and an empty allowlist blocks every host.
  A lane can't reach a Unix socket under `~/.10db/`.
- **MCP.** Over HTTP with `bearer_token_env_var`, `required = true` and `default_tools_approval_mode = "approve"`. The
  token stays out of commands' environment under `inherit = "none"`; the hook process still has it.
- **Lifecycle.** `thread/resume` across a process restart, `turn/interrupt` in 0.8 s, `turn/steer` during a turn, and
  two app-servers on one home.
- **Limits.** `account/rateLimits/updated` carries `usedPercent`, `windowDurationMins` and `resetsAt`. A hard limit is a
  failed turn with `codexErrorInfo: usageLimitExceeded` and `willRetry: false`. Token updates fire per model request:
  `last` is that request, and `total` is the whole thread, earlier sessions included after a resume.

## Traps

1. **`thread/start` writes `trust_level = "trusted"` for the checkout when `config.toml` has no entry.** A repository's
   `.codex/config.toml` then loads: it replaced the permission profile, and its stdio MCP server ran outside any
   sandbox. `project_root_markers = []` doesn't help, and a `-c` flag doesn't beat the file. An `untrusted` entry in the
   file holds across sessions and a resume, and on a linked worktree. `config/read` shows the layer's `disabledReason`
   before `thread/start`.
2. **Hooks fail open.** Exit 1, garbage, a timeout, and `permissionDecision: ask` or `allow` all let the call run. Only
   `deny` and exit 2 block.
3. **An untrusted hook is skipped silently.** `hooks/list` shows `untrusted` or `modified`, with no error. A hook passed
   with `-c` is never trusted.
4. **The default sandbox can read `auth.json`.**
5. **The host allowlist needs `features.network_proxy = true`.** Without it every host is reachable, silently. A blocked
   host kills the whole command and loses its output. `mode = "limited"` also kills a POST to a listed host; `full`
   doesn't.
6. **The environment is inherited by default.** `shell_environment_policy` with `inherit = "none"` and a `set` table
   gives a clean one, which must hold `PATH`, `HOME` and `TMPDIR`.
7. **`":root" = "deny"` with a written list crashes every command** with exit 134. `":minimal" = "read"` plus explicit
   reads works.
8. **Commands outlive the session.** A command finished after `turn/interrupt` and after the app-server was killed.
9. **Sandbox tests from `/tmp` mislead.** Under `/private/tmp`, plain denies and `.git`'s protection appeared not to
   hold. From a path under the home folder they hold.
10. **`write_stdin` isn't seen by the hook.** Text reaches a running process unguarded, inside the kernel sandbox.
    `features.unified_exec = false` doesn't remove it.

## Not verified

- A token refresh with lanes running.
- A real hard limit, and what happens past it with credits on the account.
- 10db's real lane profile translated in full, with a real toolchain.
- Lanes side by side at real scale, or a long turn.
- `forced_chatgpt_workspace_id`, which may sign a home out on a mismatch.
- The `mcp_tool` hook handler.
