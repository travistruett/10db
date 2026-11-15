# The builder's MCP servers run outside the sandbox, from home, approved once

- **Date:** 2026-11-14

## Decision

The MCP servers in the builder's `~/.claude.json` (user and project scope entries it holds) and
`~/.codex/config.toml`, and those of the plugins the builder enabled, work in 10db's sessions as they work in
Claude Code and Codex.

- **They run as those tools run them:** outside every sandbox, from the builder's home, with the login
  environment's credentials and no 10db credential. A stdio server starts through `env -i` from the home, its env
  in a sealed file in the files root: no value is on its command line, and no checkout is its folder.
- **Approved once.** The builder approves each server in Settings › Trust. The approval is keyed by a hash of its
  command, args, working folder, tool filters, non-secret env values and URL, and header names. A changed config
  asks again. A server switched off in its source stays off; Settings has a switch for each, and each project
  has a control.
- **The launcher refuses lane-written code.** A server whose command, an argument piece, its working folder or a
  declared code-loading variable lies where a lane can write (a checkout, the worktree folder, a temp folder,
  after resolving links, `~` and case) is left out with the reason. The login environment's `PATH` loses entries
  a lane can write, and a code-loading variable that points there is dropped. This is best effort: a shim on
  `PATH`, an `sh -c` script or a server that loads code from a checkout by its own logic passes it.
- **Agents never read the config files.** `~/.claude.json` and `~/.codex/config.toml` stay protected reads. 10db
  reads them as the daemon, and no secret value reaches Settings.
- **Calls are judged.** Their tools act outside the sandbox with the builder's access, so no allow rule names
  them. Each call goes to the guard and the judge with the policy line, a card when a person is in the session,
  and a skip when none is.
- **Both providers.** Claude sessions (plan, API key, Bedrock) and Codex sessions (lanes, chats and Plan) get
  the same servers. Codex's tool filters and timeouts from `config.toml` apply on Codex; Claude ignores them.
  Live rows on the real Claude Code and Codex show a lane's shell, and a Codex explore thread's, can read none of
  a server's env, arguments, env file or the builder's config files.
- **Left for later:** servers that sign in with OAuth (Claude's `needs-auth`; Codex's `mcpServerStatus/list`), the
  local scope of `~/.claude.json`, `headersHelper`, tool filters on Claude, and a `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME` set in the builder's shell.

## Why

The builder's direction is parity with Claude Code and Codex: MCP has to work for 10db to replace them. A server
the builder installed is the builder's code, as their skills and plugins are. The containment that matters is
that no lane can choose the code such a server runs, and no lane can read what it holds, so the launcher refuses
lane-written code and the files root and process info stay behind the kernel sandbox. Running the servers inside
srt, as repo servers do, would break most of them: they need the home, the network and the builder's tools.
Asking again on every session would add friction Claude Code does not have, so one approval covers a config until
it changes.
