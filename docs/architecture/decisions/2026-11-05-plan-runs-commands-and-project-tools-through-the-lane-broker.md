# Plan runs commands and the project's MCP tools in a read-only sandbox, through the lanes' broker

- **Date:** 2026-11-05
- **Amends:** `decisions/2026-11-02-shape-session-and-convert.md` (a Shape session runs no command and loads no
  project MCP server), `decisions/2026-11-03-plan-researches-the-web-through-a-researcher.md` (the agent holding
  the code never sends a request), `decisions/2026-11-03-plan-sees-the-app-through-screenshots-not-a-browser.md`
  (any `mcp__` tool other than 10db's is refused); spec `docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md`
  §5.2

## Decision

A Plan (Shape) conversation can do deep research: it runs commands, calls the MCP servers the builder approved
for the project, and fans out code-research agents, each on a model it names. It still writes nothing to the
repository, and it asks the builder before anything that is not a read. Commands and project tools are one
mechanism, the one lanes already have, not a second one built for Plan:

- **A read-only lane sandbox.** When the daemon has a lane sandbox, each Plan session gets one from
  `LaneSandbox.forSession` with `readOnly: true`. The profile is the lane profile with the checkout itself added to
  `denyWrite`, over the write Claude Code opens for its working directory, so its commands write only the
  session's own temp dir, whatever a card allows. The same call sandboxes the project's approved stdio MCP servers,
  each in its own srt sandbox, as for a lane. With no lane sandbox (development on the fake adapter, tests) a Plan
  session has no `Bash` and no project server, as before.
- **The lanes' broker, for a conversation.** The PreToolUse hook (`judgeShapeCall`) judges a `Bash` call with the
  guard a lane's commands meet (`judgePreToolUse`, with no areas, hazards or claims): what it refuses stays
  refused, a command it reads as read-only and naming no protected path runs without asking (the lanes'
  read-only line), and any other answers `ask`. A call to a project MCP tool (`mcp__<server>__<tool>`, any
  server but 10db's) always answers `ask`. An `ask` reaches `canUseTool`, which is `createPermissionBroker` with
  no workstream: the owner is the conversation (`shapeId`), stored rules are the project's only, and the broker
  cards every command that reaches it (`commandsAsk`), hazard or not, where a lane's would run a non-hazard one
  unasked. A conversation's card has no target and names the conversation in its detail (`shapeId`); it folds
  with no lane's card; it offers Allow once, Always allow in this project and Deny (no workstream rule); and it is
  withdrawn when the session stops waiting on it. A host the sandbox meets is refused and carded once, as for a
  lane. Allow always for a project tool is stored per tool name, as for a lane.
- **Who may do what.** The session and the `code-researcher` agents it launches run commands. The web researcher
  and the reviewers run none. Only the session calls a project MCP tool; an agent it launches is refused one.
  The web stays the web researcher's: `WebSearch` and `WebFetch` are refused to the session and to the code
  researchers.
- **Its commands end with it.** The daemon spawns a Plan session's Claude Code itself (at the daemon's priority,
  not a lane's background one), and the sandbox watches what runs under that process and stops it when the session
  ends, as a lane's (`LaneSession.trackProcesses`, `endProcesses`). The hook also refuses `run_in_background`, a
  job put in the background with `&` (nested scripts included), a command led by `nohup`, `setsid` or `disown`, and
  `dangerouslyDisableSandbox`, and it launches every agent in the foreground (`run_in_background: false` set over
  the call), so an agent ends within its turn. These refusals read the command's words; the watch is what holds.
  `Monitor` stays disallowed.
- **What it is given.** The project's servers are resolved from the project env (the login env with every
  billing switch and account secret stripped), as a lane's are, never from the session's own env, which holds the
  account's key. A remote server on this Mac or its network (an address, `localhost`, a `.local` name) is left
  out of a Plan session, since Claude Code connects to it outside every sandbox. An agent runs only on a model the
  project's account offers. A conversation's card never folds, not even with its own: two calls made at once wait
  on a card each, and a card goes with its call when Claude Code cancels the call. A session whose servers' AWS
  credentials expire within five minutes gives way at the next turn to a fresh session, resumed, with new ones.
- **Less, never nothing.** A `.mcp.json` that can't be read leaves the session with no project server, and a
  sandbox that can't be built with no command and no project server; its first message says which and why.
- **Code research.** A fifth programmatic agent, `code-researcher`, has `Read`, `Grep` and `Glob`, and `Bash` when
  the session has its sandbox. It reaches no web page and no MCP server and launches nothing. The session may
  name a model on each `Agent` call (`opus`, `fable`, `sonnet` or `haiku`; anything else is refused); with none
  the agent runs on the session's model. On an account with a model map, `launch.ts` sets Claude Code's
  `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` for each mapped alias, so a subagent named by alias runs on the account's
  model (on the Orgtools Bedrock account, `fable` is `us.anthropic.claude-fable-5-1`). Bedrock serves Fable only
  when the account's data retention mode in the region is `aws_review` (prompts and outputs kept in AWS up to 30
  days, flagged traffic open to AWS review); on `default` every Fable call fails with a ValidationException, seen
  live on the Orgtools account. That is an account setting for the builder to choose; 10db changes no account
  setting, and the picker offers Fable either way.
- **Every call shows.** Each command and project tool call the hook lets through or sends to the builder writes a
  dimmed line naming the agent that made it, and a call that waits on a card says so in the conversation.
- **AWS credentials for an approved server, never `~/.aws`.** A stdio server whose declared env sets a literal
  `AWS_PROFILE` gets, in place of the profile, short-lived credentials for exactly that profile, exported by the
  daemon outside the sandbox (`aws configure export-credentials`, with the `aws` from the fixed install prefixes,
  never the login PATH). The grant is part of the config hash, so an approval given before it existed asks again,
  and the approval card says what the server gets. An expired AWS login leaves the server out with a card saying
  to run `aws sso login --profile <profile>`. uv's caches move into the sandbox's own temp dir as npm's and pnpm's
  do, and a stdio server's profile opens the Mach service `com.apple.SystemConfiguration.configd` beside
  FSEvents: uv's HTTP client reads the system proxy settings through it as it starts and panics without it (seen
  live: `system-configuration ... Attempted to create a NULL object`). It answers what the network is set to and
  opens no route past the proxy; a lane's own commands don't get it.
- **A server that fails to connect is named.** The session's first message names each project server Claude Code
  could not connect, as a lane's does, so it tells the builder instead of guessing.
- **Unchanged.** The file tools still read only the checkout and the conversation's files directory and refuse the
  rest with no card. A protected path stays refused to the file tools, and to commands by the kernel: a command
  that names one is carded like any other that isn't read-only, and the sandbox refuses the read. `Edit`, `Write`
  and `NotebookEdit` are still disallowed.

## Why

The builder's principle (`pri_01a1ace7`): the builder provides judgment and decisions, and 10db collects and
analyzes. A planning session that can't run `git log`, read the cost data or ask for a command makes the builder
fetch and paste what it could get itself. The ask is for permission, not material.

**One mechanism.** Lanes already judge commands with the guard, card what needs a person through the broker,
store the builder's rules and sandbox stdio MCP servers, and every piece has its tests and its live test. Plan
reuses them. What differs is narrow: no workstream owns the card, every non-read-only command is asked about, and
the sandbox can't write the checkout.

**The researcher split, thought through.** The split kept the agent holding the code from sending requests. That
no longer holds for the session itself, and it is given up on purpose, with these limits in its place:

- The session's commands reach only the hosts the project already allows, through the sandbox's proxy. Any other
  host is refused and carded per host.
- A project server reaches only the hosts its approval names (`decisions/2026-10-27-mcp-approval-hosts.md`), and
  a stdio server never reaches loopback. Every call to one is carded unless the builder allowed that tool always,
  and each call shows in the conversation either way. So code can leave the machine only to a destination the
  builder approved, and only by calls the builder sees.
- The open web stays with the web researcher, which still holds no file of the project. The code researchers
  hold the code and have no web tool and no MCP server; their commands, like the session's, reach only the
  project's allowed hosts, and only after a card or a rule the builder stored.

What a command or a server returns is untrusted, as a web page is: an AWS resource name, a tag or a log line can
carry instructions. The prompts say so, and the checks behind them stand: the builder accepts a plan before any
lane sees a task, and nothing the session holds can write the repository.

**Browsers.** The screenshots decision refused every non-10db MCP tool so that nothing in a Plan session could
click in 10db's own window. A project stdio server under srt never reaches loopback, and a remote one on this Mac
or its network is left out of a Plan session, so 10db's window is out of their reach, and each call is the
builder's call on a card. A browser server approved for the project is therefore allowed in the sandbox like any
other. Without a sandbox, every non-10db tool is refused as before.

**AWS.** Opening `~/.aws` to a server would hand it the SSO token, and that token gets credentials for every role
the builder holds, `AdministratorAccess` included. Exporting one profile's credentials makes the server that one
role (for the Orgtools audit, `orgtools-prod`: AWS's `ReadOnlyAccess`). The credentials last the role's session
(an hour for the Orgtools permission sets); a Plan session closes after 10 idle minutes and starts again with
fresh ones. The `aws` CLI runs outside every sandbox, so it is looked up where no lane writes. The grant is in
the hash because an approval is consent to an exact config: a server approved when a literal `AWS_PROFILE` gave
it nothing must not start receiving credentials without a new card.

**Turned down.** A second, Plan-only permission system: two sets of rules for the same commands, and new code
on the path that matters most. Refusing every command that is not read-only: the builder would fetch the output
of anything else by hand, which is the bug the principle names. Opening `~/.aws` read-only: boto3 rewrites the SSO
cache when it refreshes, and the token is the admin problem above. Refusing background jobs by their words alone:
`env nohup`, `sh -c '… &'`, `tmux new -d` and their kin read as ordinary commands, so the session's processes are
watched as a lane's are. Turning Fable on for routing: as strong a tier as Opus, it would take every lane's plan and review steps
unasked; the picker and the code researchers offer it, and choosing a task's model is its own task.
