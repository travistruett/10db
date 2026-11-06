# Codex lanes run under Codex's sandbox and are judged by a trusted PreToolUse hook

- **Date:** 2026-11-05

## Decision

A Codex lane meets the bar `decisions/2026-10-29-sandbox-is-the-boundary.md` sets: the kernel sandbox is the boundary
and the guard is a filter in front of it. 10db relies on Codex's own sandbox and hooks and adds no layer of its own.

- **The guard runs from a `PreToolUse` hook, not from approvals.** Sessions start with `approvalPolicy: "never"`: the
  hook reaches every shell, patch and MCP call, so approvals would only card ordinary commands. The hook is a short
  `/bin/sh` script in the account's home that sends its input with `/usr/bin/curl` to a Unix socket the adapter opens
  for the session in `~/.10db/run/`. `deny` refuses, `ask` holds the request open while `canUseTool` raises its card,
  and `allow` runs. `Bash` and `mcp__*` calls reach the guard unchanged, `apply_patch` becomes one `Edit` per path it
  names (any refusal refuses all), and any other tool is refused. The app-wide auto-mode setting does not apply.
- **Hooks fail open, so every failure is exit 2.** A crash, a timeout, garbage or an `ask` from Codex lets the call run,
  and only `deny` and exit 2 block. So the script exits 2 when `curl` fails for any reason, `curl`'s `--max-time` comes
  from the session's tool timeout so it gives up before the hook's own timeout, and a stopped session closes its socket.
- **A hook runs only with its trust hash,** and one passed with `-c` is never trusted. The hook lives in the home's
  `config.toml` with the `trusted_hash` read from `hooks/list` when the home is prepared.
- **Start checks.** Before any prompt, a session pins `[projects."<checkout>"] trust_level = "untrusted"` in the home's
  `config.toml`, starts `codex app-server --stdio --strict-config`, warns on an unverified version, confirms the account
  and workspace, reads the config layers (the project layer is absent or disabled), confirms the hook is trusted and
  enabled, and after `thread/start` confirms the `lane` profile and the requested model. Any failure ends the session
  with `sandbox_refused` or `account_refused`.
- **The `untrusted` pin must be in the file, and before `thread/start`.** Otherwise `thread/start` writes `trusted` for
  the checkout, and the repository's `.codex/config.toml` replaces the sandbox and starts its own MCP server outside it.
  A `-c` flag does not beat that entry. A pinned `untrusted` entry held across a first session, a second session, a
  resume and a linked worktree. So a Codex lane ignores a repository's `.codex/`.
- **The sandbox translation.** `laneSandbox.forSession` runs as it does for Claude and one translator turns its
  settings into `permissions.lane`, closed by default: `:minimal` read as the base (`:root` deny plus a list crashed
  every command), `allowRead` as read, the checkout and `allowWrite` as write, other `denyRead` entries as deny,
  `denyWrite` as read only under a writable path (elsewhere no entry, so it stays closed), the allowed hosts as
  `network.domains` with `mode = "full"`, and the session's command env as `shell_environment_policy.set`.
  `shell_environment_policy.inherit = "none"` keeps the 10db server's token out of commands' reach.
- **`full`, not `limited`.** `limited` kills a command that POSTs, but only plain HTTP is method-checked: an HTTPS POST
  passes even in `limited`. Claude lanes have no method limit either. A wildcard host such as `*.example.net` matches
  hosts under the domain but not `example.net` itself, as srt does.
- **Known gaps, accepted.** `write_stdin` is not seen by the hook, so text can reach a running process unguarded; the
  kernel sandbox still bounds it. There is no auto-mode classifier: what the guard allows runs inside the sandbox
  without another check. A lane spends a read on `AGENTS.md`, and a project's `.codex/` doesn't apply to its lanes.
  Left out on purpose: a sandbox self-test at runtime, a CI job on the real Codex binary, and closing `write_stdin`.
  `/private/tmp` access is in `decisions/2026-11-05-sandbox-files-leave-private-tmp.md`.

## Why

Travis, 2026-11-05: use reasonable best practices at the bar Claude Code and Codex set, without going overboard.

Approvals would card every ordinary command, and the hook sees what approvals see plus code-mode and subagent calls.
Because hooks fail open, a guard that depended on the default would let a broken socket mean "allow"; making every
failure an explicit exit 2 turns it into a refusal. The pin is in the file because the spike showed nothing else holds
against the trust write. The translation uses `:minimal` because the spike measured `:root` deny plus a list crashing
every command, and `full` because `limited` buys no method limit on HTTPS.

The spike is `docs/architecture/research/spike-16-codex-app-server.md`; the design is
`docs/superpowers/specs/2026-11-05-10db-chatgpt-plan-design.md`.
