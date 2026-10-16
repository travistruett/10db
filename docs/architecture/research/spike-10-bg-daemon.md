# Spike 10: What `claude --bg` exposes

- **Status:** PARTIAL
- **Date:** 2026-10-15
- **Versions:** claude 2.1.300 (Claude Code) · Agent SDK 0.3.299 · Node v25.2.1
- **Command:** manual CLI session (no probe script), under `env -i HOME PATH USER SHELL TERM`

## Question

What `claude --bg` exposes programmatically (events, permission routing), for a later revisit.

## Result

`claude auth status` under the clean env reported `authMethod: claude.ai`, `apiProvider: firstParty`,
`subscriptionType: max`. `claude agents --json` returns a JSON array of active sessions, interactive and
background, with the fields `cwd`, `kind`, `name`, `pid`, `sessionId`, `startedAt` and `status`. `--all` adds
completed background sessions, and `--cwd <path>` filters. Sessions started through the Agent SDK showed up
there too, as `kind: interactive` (spike 6's held session was listed with `status: waiting`).

No `--bg` session was started, for two reasons:

- `--bg` refuses `-p/--print`. Its message: "--print never starts the interactive session that `claude agents`
  attaches to, so the job would be unattachable". The prompt is the positional argument instead.
- `--bg` refuses an untrusted workspace ("Workspace not trusted. Run `claude` in <dir> once and accept the trust
  prompt"). A fresh `mktemp` repo is untrusted. Going further would have meant changing the builder's trust
  config or running in the real checkout, so the 30-minute timebox stopped here.

From `claude --help`:

- `logs <id|name>` prints a background session's "recent terminal output", which suggests rendered terminal text
  rather than stream-json events. Not observed.
- `--permission-prompts host|none` applies only with `--print`, which `--bg` can't use. So it looks like
  permission prompts of a `--bg` session can't be routed to a host; they wait for someone to `claude attach`.
  Inferred from the help text, not observed.
- `stop|kill <id>` keeps the conversation (`attach` or `--resume` reopens it).
- `rm <id>` deletes the session, and its worktree when that is safe.
- `respawn [--all]` restarts sessions on the current version.
- `--bg --resume <session-id>` continues an existing session in the background.

## Evidence

```
$ claude agents --json            → [ {cwd, kind, name, pid, sessionId, startedAt, status}, … ] (2 entries: this
                                     builder session, kind interactive, status busy; spike 6's SDK session,
                                     kind interactive, status waiting)
$ claude auth status              → {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",…,"subscriptionType":"max"}
$ claude --bg -p "Reply OK." --model haiku
--bg and --print conflict: --print never starts the interactive session that `claude agents` attaches to, so the job would be unattachable. The prompt is the positional — drop --print: `claude --bg '<task>'`.
$ claude --bg "Reply OK." --model haiku
Workspace not trusted. Run `claude` in /private/var/folders/…/tmp.ZTLHW7Tp4F once and accept the trust prompt, then retry.
```

The plan's step "stop every listed agent" was skipped on purpose. The listed agents were the builder's own live
session and a running spike, not stale `--bg` jobs.

## Consequence for M1

None for M1, which uses the Agent SDK (decision 5). Revisit after M2 for terminal takeover and supervision. When
revisited:

- `claude agents --json` is a ready-made process inventory, and it already lists SDK sessions.
- `--bg` needs a trusted workspace.
- Host permission routing appears to be `--print`-only.
