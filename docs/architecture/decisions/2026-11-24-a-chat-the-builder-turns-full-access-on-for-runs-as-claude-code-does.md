# A chat the builder turns Full access on for runs as Claude Code does in a terminal

- **Date:** 2026-11-24
- **Amends:** `decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md` (the sandbox stays the
  security for every session but a Full access chat), `decisions/2026-10-31-lanes-run-in-auto-mode-inside-the-sandbox.md`
  (an unsandboxed session may now run in auto mode, but only a Full access chat),
  `decisions/2026-11-14-claude-ai-connectors-are-relayed-under-strict-mcp-config.md` and
  `decisions/2026-11-14-the-builders-mcp-servers-run-outside-the-sandbox-from-home.md` (a Full access chat lets
  Claude Code load the builder's servers itself), and `decisions/2026-11-12-codex-is-judged-by-10dbs-judge.md`
  (a Full access Codex chat runs Codex's full-access sandbox mode, still judged by 10db's judge)

## Decision

A chat has a **Full access** switch, off by default, turned on by the builder from the title row's ⋯ menu after
one confirmation and off from the badge it shows. It is stored on the chat, survives a restart, and applies from
the chat's next turn. While it is on:

1. **No 10db sandbox.** The session's commands and file tools reach everything the builder's user can: any path,
   any host, localhost, Docker, `.env` files, the Keychain through the builder's own tools.
2. **Claude Code loads the builder's setup itself**: `settingSources` `user`, `project` and `local`, with
   `strictMcpConfig` off, so the builder's settings, hooks, plugins, skills, instructions and MCP servers load as
   they do in `claude`. 10db passes only its own `/mcp` server. 10db's setup wrapper, its relay of the builder's
   servers and its injected instructions are left out, so nothing loads twice. On an account with its own config
   folder (an API key, Bedrock, a second plan) the `user` source is that folder, so 10db keeps its relay of the
   builder's setup there, as a sandboxed chat has it. Like `claude` in a terminal, the agent can read what the
   builder can, 10db's own Keychain entries included.
3. **One judge, the agent's own.** On a Claude account where auto mode runs, the chat runs in Claude Code's auto
   mode with its built-in rules; where it doesn't (a Bedrock key, a model without auto mode) it runs in `default`
   mode, and each ask is a card in the chat, as Claude Code's own prompt would be. 10db's hook judge and the
   trust policy's auto-mode rules are not added. A Codex chat runs `danger-full-access` and keeps 10db's judge,
   which is Codex's judge today (Auto-review reviews only escalations, which full access almost never raises).
4. **What stays, all for 10db's own writers or its billing line:**
   - The folder hold. With no kernel to stop a shell write, a Full access turn takes the hold wherever the chat
     works, waits for it rather than running read-only, and keeps it until the turn's background commands end.
     Turning Full access on while the chat is still reading records Here, as Open in Terminal does.
   - The chat's and Plan's 10db tools and their policy, and the title row's git steps.
   - The account checks, and the billing check, which for a Full access chat reads every settings file the
     session loads, at start and again mid-session.
5. **Attended only.** Only a chat has the switch; Plan turns inside that chat run with it, since they are the same
   conversation. A board task, a lane, a pass, the gate and a task a chat hands off never read it: the flag exists
   only on the chat's session spec type, and the adapter still refuses a lane with no sandbox.

## Why

- **The builder drops out of 10db to work on 10db.** "When I try to work on 10db within 10db... I immediately
  just hit walls." The walls are the sandbox's own rules meeting 10db's own repository: `~/.10db` is closed, git
  state is the daemon's, the gate refuses an srt in the checkout it gates, other checkouts such as `agent-os` are
  read-only, and the builder's own tools (Aside among them) are absent. The builder wants one pane of glass.
- **It is what Claude Code does.** The trust decision's tie-breaker is to do what Claude Code does; a terminal
  `claude` runs the builder's setup on auto mode with no sandbox. A chat the builder is in has the builder as its
  oversight, which is what the sandbox stands in for when nobody is there.
- **The trust decision turned down opt-in power switches as a fix for a bad default.** This is not that: the
  default chat keeps the sandbox and stays the place to loosen what everyone feels. Full access is a deliberate,
  visible choice for one conversation, the in-window form of Open in Terminal
  (`decisions/2026-11-16-open-in-terminal-runs-the-agents-own-tui-outside-the-sandbox-holding-your-folder.md`),
  which already runs a chat outside the sandbox holding Your folder.
- **Keys.** An API-key account reads its key through `apiKeyHelper`, as the takeover does, so the key is never in
  the agent's environment. A Bedrock key has no helper; its chat keeps `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so
  it runs in `default` mode rather than hand the key to the agent's commands.
- **Turned down:**
  - Bypass mode (no judge at all): it goes further than the builder's terminal, and auto mode already asks only
    about force pushes, production deploys, destroying files the session didn't make and sending data out.
  - Keeping 10db's hook judge alongside auto mode: two judges asking about the same call is the friction this
    removes.
  - A per-project or app-wide setting: it would carry into chats the builder isn't thinking about.
  - Codex `workspace-write` with Auto-review: Codex's own sandbox keeps most of the walls this exists to remove.
