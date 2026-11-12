# 10db trust line: one policy, a judge per agent, nothing waits on the builder, and the builder's setup comes along

**Status:** designed on 2026-11-12 with the builder. Nothing in it is built. Calls the builder has not made are
marked **(call)** and listed in §15.

**Decision:** `docs/architecture/decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`, and the
rule in `AGENTS.md` ("Trust the developer, contain the agent").

**Research:** `docs/architecture/research/2026-11-12-trust-line-research.md`: the inventory of today's
restrictions, prior art, and the judges Claude Code and Codex ship, with sources.

**Changes:** lanes, the pass, Plan, and the designed Sessions chat
(`docs/superpowers/specs/2026-11-11-10db-sessions-design.md`, which is revised on top of this, §13).

**Keeps:**

- The kernel sandbox and its adversarial review (`decisions/2026-10-29-sandbox-is-the-boundary.md`).
- Pinned, verified agents (`decisions/2026-11-08-10db-runs-pinned-copies-of-codex-and-claude-code.md`).
- Provider parity (`AGENTS.md`).
- The coordination rules, where another writer can exist (§7).

**Words:**

- A **limit** is one of the four hard limits (§2).
- The **policy** is the provider-neutral statement of the limits and the project's switches (§3).
- A **judge** decides whether a call crosses a limit: Claude Code's auto mode or 10db's judge (§4).
- **Attended** work is a conversation the builder is in: a chat, Plan, or a pass turn. **Unattended** work is a
  task 10db runs on its own (§5) **(call)**.

## 1. Intent

The builder, on the Sessions design: "I am worried that we've gone overboard and that we have too many
restrictions in place." "We need to trust developers. This is a developer tool and if it's too rigid, I'm never
gonna use it and people are never gonna use it." "Every single time I talk to you you're going much more toward
enterprise security."

On what must work: "I absolutely rely on research. Search the web, look at documentation, go look at
competitors." "I definitely rely on skills a lot." "Sometimes I just wanna be able to say hey, we're gonna fix
this button super quick, or bump this package really quick, and I just want it done." "I want to be able to use
MCP and skills and all the stuff with minimal friction."

On judgment: "This is where Claude auto mode is really, really good and I no longer ever have to think about it,
because it just knows when to prompt me in a really intelligent way."

On unattended work: "My whole goal is that this can run autonomously without me while I am in meetings. If I have
to constantly babysit this, it defeats the entire point."

On where to set the bar: "I generally wanna be able to adhere to what Claude does", "as frictionless as possible
across Claude, ChatGPT, etc."

**Goals**

1. Every agent surface is fully featured by default: web, the builder's skills and plugins, MCP servers, and the
   project's instructions.
2. One provider-neutral policy with four limits, enforced by the best judge each agent has.
3. Unattended work never waits on the builder.
4. A chat can do the work, not only talk about it.
5. The same on every account kind.

**Anti-goals**

- A card for a call that touches no limit.
- A task waiting on the builder.
- A rule copied from one surface to another without a reason tied to a limit or to coordination.
- A provider check above the adapters.
- A sandbox the judge's mistake can cross.

## 2. The line

**Four limits.** An agent asks (attended) or skips (unattended) before it:

1. **Destroys data it didn't create:** dropping or wiping a database, deleting files that existed before the
   session, rewriting history others have (force push), `rm -rf` on what it didn't make.
2. **Sends data out:** code, files, keys or the conversation to somewhere the builder didn't send them.
3. **Reads secrets:** `.env` files, keys, credentials, the Keychain.
4. **Writes to anything live:** a deploy, a migration against a non-local database, a cloud CLI's write
   (`aws`, `gcloud`, `kubectl`, `terraform apply`), publishing a package, merging a pull request.

Reading from live systems is allowed: `aws s3 ls`, a `SELECT` against staging, `kubectl get`.

**Kept as rules (the sandbox's integrity).** These are not judged, because a judge's mistake here is a way out of
the sandbox:

- writes only in the checkout and the session's temp dir;
- credential stores unreadable: the Keychain, 10db's data dir, `~/.claude.json`, each account's config dir,
  Claude and Codex credential files;
- the checkout's `.env*` files, by session **(call)**:
  - Unattended: kernel-denied, so a read is skipped and listed.
  - Attended: readable by the kernel, with "reading `.env` files or other secrets" as a limit line the judge asks
    about.
  - The project switch "Agents may read `.env` files" makes both readable without asking. The sandbox profile is
    fixed when a session starts, so the switch applies from the next session.
- code the agent runs reaches the network only through the sandbox's proxy;
- config an agent writes that would run outside the sandbox (`.claude/settings*.json`, `.claude/hooks`,
  `.mcp.json`, shell rc files, a mise config) runs only after the builder approves it;
- Docker only when the project turns it on, since Docker can mount any folder;
- pinned, checksummed agents.

**Everything else runs:** edits, installs, tests, builds, local git, the web, skills, MCP tools, local servers,
background jobs (stopped when the session ends, as lanes already are).

## 3. The policy

One `TrustPolicy` in `packages/contracts`, built per session by a daemon module `trust/`:

- **The limits**, as prose sentences a judge can weigh, in one place (`trust/limits.ts`). Each names its limit,
  so a denial can say which one it was.
- **The environment:** the project's name, its live hosts and accounts if the builder named any (Settings ›
  Project › Live systems, for example `api.example.com`, the `prod` AWS profile), and the checkout path.
- **Coordination lines** for the surface (§7), for example "the full gate is 10db's".
- **The switches** (§9).
- **Attended or unattended** (§5).

The policy is the only input every judge gets. Nothing above the adapters reads a provider.

## 4. Judges

Each adapter reports `capabilities.judge`: `native`, `tendb` or `rules`. It is part of the Sessions spec's
`AgentCapabilities` (M2b there), evaluated per live session, not per account: it depends on the account kind and
the model, and a model change that drops auto mode (`setModel` to an unsupported model) switches the session to
`tendb` at the next turn **(call)**.

| Agent | Judge | How the policy reaches it |
| --- | --- | --- |
| Claude on a plan, the API, Bedrock or Vertex, on a model auto mode supports | `native`: auto mode | `permissionMode: 'auto'` and inline `settings.autoMode`: `"$defaults"` first in every list, then the policy's environment and coordination lines. Built today for lanes (`sandbox/auto-mode-rules.ts`); this extends it to every surface. |
| Claude on a gateway account, an unsupported model, or with auto mode disabled by an admin | `tendb` | The PreToolUse hook (built) sends each call to 10db's judge. |
| Codex | `tendb` | `approvalPolicy: never` (built) and the hook (built) sends each call to 10db's judge. Auto-review reviews only escalations (sandbox escapes, blocked hosts, MCP prompts), which stay closed, so it never sees a call inside the sandbox; live check L5 confirms it with the lane profile and the guard hook. |
| An ACP agent (later spec) | `tendb` | Its permission requests go to 10db's judge. |

**10db's judge** extends `apps/daemon/src/judge/` (built: it asks a model through OpenRouter, logs every call in
`judge_calls`, and falls back to a rule when it can't answer). A new decision, `crossesLimit`:

- **Fast path, no model:** reads, edits inside the checkout, and commands the read-only line already passes
  (`guard/read-only.ts`, built) are allowed at once. This is meant to catch most calls.
- **The model** gets the call, the cwd and the policy, and answers `allow`, `limit` (naming which) or `unsure`.
  `unsure` counts as `limit`.
- **No judge available** (no OpenRouter key, the judge switch off, an error): the `rules` floor. Today's guard
  answers. Its refusals stand, and anything it would have asked about is treated as `limit`, so it still never
  waits unattended.

**The guard after this.** The PreToolUse hook stays on every agent. It carries only the coordination rules (§7)
and the `rules` floor. Its other refusals stop applying where a judge runs:

- the git and gh allowlists, outside a lane;
- the deploy and publish list, which becomes limit 4;
- the "can't read this shell" refusals, which go to the judge;
- the cards for web, MCP and unknown tools.

**Cost.** Auto mode's classifier runs on Sonnet 5 by default and counts toward usage on API and Bedrock accounts.
10db's judge costs about $0.0002 a call through OpenRouter
(`decisions/2026-10-31-openrouter-makes-routine-decisions.md`). The fast path skips both for reads and edits.

## 5. Attended and unattended

**Unattended (lanes: Board tasks, worktree tasks, follow-ups):**

- At a limit, the call is denied with a message: "Skipped: this would <limit>. Carry on without it and say in
  your handoff what you skipped." Auto mode already keeps working after a block in a headless run; 10db's judge
  sends the same message, on Claude and on Codex.
- When a judge stops the turn after repeated denials (auto mode has its own threshold; 10db's judge never stops
  a turn), the runner resumes it with the same message. A turn is stopped this way at most twice; after
  that the step ends with its handoff and the skips are listed.
- The daemon records each skip in a `skipped_actions` row (workstream, call summary, limit, reason, time).
- When the task ends, one Inbox item, **Skipped while you were away**, lists them. Its actions are **Run these
  now** and **Dismiss**. Run these now starts a follow-up task **(call)**:
  - It starts from where the task ended: its branch if it hasn't landed, the base after it has.
  - It is unattended.
  - Its brief lists the skipped actions as approved, and each judge gets them as allow lines. They are matched
    by intent, not exact input, so a rewritten command still counts.
- **What the sandbox keeps as rules** (§2) is handled without waiting:
  - An agent may write `.claude/settings*.json`, `.claude/hooks`, `.mcp.json` or a mise config in its checkout.
    What it wrote doesn't run until the builder approves its hash (the built `.mcp.json` approval). The Inbox
    item lists it.
  - Docker while the project has it off is skipped and listed.
  - Shell rc files outside the checkout stay unwritable.
- A task fails only when its step reports that it couldn't do its job without the skipped call.
- **No card waits on the builder in unattended work.** Each card that waits today goes to the judge instead:
  "Allow Bash?", web and MCP calls, an unknown tool, a background loop, an unread hazard command and a new
  network host.
- **A new network host** goes to the judge with the command that wanted it. Allowed hosts are added to the
  session and listed on the task. Settings offers to keep them for the project. On Codex, whose host list is
  fixed at start, the agent asks for a host with a `request_host` tool, which goes to the same judge.

**Attended (a chat, Plan, a pass turn):**

- At a limit, 10db does what Claude Code does **(call)**:
  - **Claude:** the four limits are written as `soft_deny` lines, so the builder's explicit go-ahead in the
    conversation clears them. A denial shows in the transcript with **Allow this**, which sends that go-ahead as
    the builder's message. A call the classifier escalates reaches `canUseTool` (built) and shows as a card
    inline and in the Inbox, as one object (the Sessions spec's S13). Auto mode's own `$defaults` hard denies
    stay as Claude Code ships them.
  - **Codex:** 10db's judge, which cards, as below. Auto-review reviews only escalations, which stay closed
    (L1, L5).
  - **10db's judge:** a card, as above.
- A card answer is Allow once, Always in this project, or Deny. **Always in this project** stores a grant keyed on
  the limit and its target in prose ("deploys to staging with vercel"), in the project's grants. Each judge gets
  the project's grants as allow lines: auto mode's `allow` and 10db's judge's prompt **(call)**.
- Anything else runs without a card.

## 6. What comes along

| Setup | Claude | Codex | Switch (default) |
| --- | --- | --- | --- |
| The project's instructions: `AGENTS.md`, `CLAUDE.md`, `.claude/rules/*.md` from the checkout | Appended to `systemPrompt` for every surface, since `settingSources: []` loads none | In `developerInstructions` (L4) | Project instructions (on) |
| The builder's own `~/.claude/CLAUDE.md` | Appended after the project's | Same text in `developerInstructions` | Your instructions (on) |
| The builder's skills (`~/.claude/skills`, `~/.agents/skills`) | A plugin dir 10db generates that links the skill folders, passed in `plugins` | `skills/extraRoots/set` for the same folders (L4) | Your skills (on) |
| The builder's installed plugins (gstack, superpowers and the rest), with their skills, agents and commands; their hooks stay out (L3b) | A wrapper per plugin in `plugins`, from Claude Code's installed-plugins list (L3), carrying no hooks and no MCP servers | Their skills via `skills/extraRoots/set`; Codex has no plugin format | Your plugins (on), each listed and switchable |
| The project's `.claude/skills`, `commands`, `agents` | A generated plugin dir over them | `skills/extraRoots/set` | on |
| The project's `.claude/settings.json` hooks | Load only after the builder approves their hash, as `.mcp.json` servers do (built) | n/a | n/a (approval) |
| The builder's MCP servers (`~/.claude.json`, `~/.codex/config.toml`) | Listed in Settings › Trust and passed to the session as Claude Code would run them; calls judged | `mcp_servers` entries | Your MCP servers (on), each switchable |
| The project's MCP servers | As built, but one approval covers the server; calls are judged, not carded | As built | n/a |
| Web | `WebSearch` and `WebFetch` allowed without a card; Plan's researcher remains as an option | `web_search: 'cached'`: answers from OpenAI's index and opens no page the agent names (T5) | Web (on) |

**Whose setup.** "Yours" is the builder's own home: `~/.claude`, `~/.agents`, `~/.codex`. It is not an account's
config dir (`environment/launch.ts:149-209`), which stays closed whole **(call)**.

**Your MCP servers in T6** are stdio and header-auth servers. Remote OAuth servers and claude.ai connectors keep
their tokens in the Keychain, so they are a follow-up with their own credential path **(call)**.

**Sandbox reads that open.** `~/.claude/skills`, `~/.claude/plugins` and `~/.agents/skills` become readable,
read-only. `~/.claude.json`, credential files, `~/.codex/auth.json` and the Keychain stay closed. This changes the
sandbox, so it gets its adversarial review (§11).

**The builder's MCP servers run as Claude Code runs them** **(call)**. That covers servers inside the builder's
plugins (context7, vercel and others) and the ones in their own config. They run outside the kernel sandbox, and
their calls are judged like any other call. Many need the network, OAuth or the Keychain, which a sandbox would
break, and the builder installed them. Servers a repository declares (`.mcp.json`) stay as built: approved by
hash and run under `srt`, since an agent can write that file.

**Hooks run.** Plugin hooks, the hooks and `allowed-tools` in the builder's and plugins' skills, commands and
agents, and approved project hooks run as they do in Claude Code. The builder installed or approved them; that is
the trust the decision extends. A plugin hook starts in its wrapper's folder, not the checkout. The live checks
(research, L3b and L3c) showed a hook's rewrite of a call is not judged again by 10db's guard and a skill's
`allowed-tools` skips the card for a call the guard passes on; the builder accepted both for what they installed.
A hook an agent wrote never runs without approval (§2).

**Not loaded:** the builder's `~/.claude/settings.json` (it can change billing, permissions and the sandbox),
their permission allowlists and output styles.

## 7. Coordination rules, scoped

These exist because 10db runs several writers at once. They apply only where another writer can exist.

| Rule | Where it applies | Where it doesn't |
| --- | --- | --- |
| Claims and hazards (lockfiles, migrations) | Lanes in parallel copies of one project; pages in a pass | A chat or a lone task with nothing else in its folder |
| Page areas | A pass | Everywhere else |
| The folder hold | Any writer in Your folder: a pass, a chat that writes there | Separate copies |
| Only 10db commits and pushes; the gate is 10db's | Lanes and passes, which 10db lands | A chat in Your folder (§8) |
| Installs through the daemon | Lanes in parallel copies | A chat in Your folder |

## 8. Surfaces

| Surface | What changes |
| --- | --- |
| **Lane** | Setup comes along (§6). Web and MCP are judged, not carded. Deploys go to limit 4. Unreadable shell goes to the judge. "Allow Bash?" goes away. Unattended rules (§5). Commits, pushes, claims and the gate stay 10db's. |
| **Gate** | Unchanged: it runs under the sandbox and runs tests, which are agent-written code. |
| **Plan** | Its own session searches and fetches the web. Commands are judged, not carded, and background jobs run under the lanes' process tracking. Setup comes along. The researcher question limit and URL rules go. Plan still writes no code: that is its job, not a security line **(call)**. |
| **Pass** | As a lane, attended. |
| **Chat** (designed, §13) | A chat can write in Your folder, holding the folder while it does, and can commit, branch and open a pull request. Pushes and merges are judged (merging is limit 4). Bigger work still goes to a separate copy as a task. Builder tools are all present; destructive ones get Undo or are judged. |

## 9. Settings

**Settings › Trust** (app-wide), each one overridable per project in Project › Trust:

- Web: on.
- Your instructions, Your skills, Your plugins (each listed): on.
- Your MCP servers: each listed, on once approved.
- Project instructions: on.
- Live systems: hosts, profiles and namespaces the judge treats as live (empty; auto mode already treats `prod`
  and `production` names as sensitive).
- Agents may read `.env` files: off.
- Docker and loopback: as built, per project.
- Judge: the model and confidence floor for 10db's judge (built under Settings › Decisions); which judge each
  account uses, read-only, from `capabilities.judge`.

A judged call's verdict shows in the transcript as a dim line when it denies, and every call is in the judge log
(built for 10db's judge; auto mode's denials are logged from their events).

## 10. Per provider

| | Claude plan, API, Bedrock, Vertex | Claude gateway | Codex (ChatGPT plan) |
| --- | --- | --- | --- |
| Judge | auto mode | 10db's judge | 10db's judge, through the hook (L1, L5) |
| Unattended skip | auto mode's own; 10db records it | 10db's judge | 10db's judge |
| Web | `WebSearch`, `WebFetch` | same | `web_search: 'cached'`: answers from OpenAI's index and opens no page the agent names |
| Skills | plugins dir | plugins dir | `skills/extraRoots/set` (L4) |
| Plugins | yes | yes | skills only; says so |
| MCP | yes | yes | yes |
| Instructions | `systemPrompt` | `systemPrompt` | `developerInstructions` (L4) |
| Without an OpenRouter key | unaffected | `rules` floor, says so | `rules` floor, says so |

## 11. Security review

- The sandbox read paths that open (§6) and the network-host judging (§5) change the sandbox, so they go through
  adversarial review, as `decisions/2026-10-29-sandbox-is-the-boundary.md` requires.
- `docs/architecture/03-trust-boundaries.md` is updated in the same pull requests: the threat model's policy
  layer becomes the judge, and its boundaries are unchanged.
- A judge's mistake is bounded by the sandbox: it can let through a call inside the line that it should have
  stopped, but not a write outside the checkout, a read of a credential store or a connection the proxy refuses.

## 12. Milestones

Each is its own pull request. T1 is this document set. M1 of the Sessions roadmap doesn't depend on any of them.

| # | What | Needs |
| --- | --- | --- |
| T1 | The belief, the decision, the research, this design (docs) | — |
| T2 | **Setup comes along:** instructions in `systemPrompt`, skills and plugins dirs, opened sandbox reads, web on everywhere, Plan's own web. Codex `web_search` and `skills/extraRoots/set`. | L3, L4 |
| T3 | **The policy and auto mode everywhere:** `TrustPolicy`, `capabilities.judge`, auto mode for Plan and passes, the guard slimmed to coordination plus the floor | T2 |
| T4 | **Unattended never waits:** skip messages, `skipped_actions`, the Inbox item, network hosts to the judge, `request_host` | T3 |
| T5 | **10db's judge and Codex:** `crossesLimit`, the hook judge on Codex, gateway accounts | T3, L1, L5 |
| T6 | **Your MCP servers** in Settings, approved once, run as Claude Code runs them, with calls judged | T2 |

T2 is the one the builder feels first and is the smallest.

**Order against the Sessions roadmap (call):**

- T2 lands on today's code, before Sessions M2b. It touches the adapters' launch options and the sandbox profile,
  not the engine.
- **Web in T2 depends on the judge.** It turns on only where a native judge exists: Claude on an auto-mode
  account, for lanes, passes and Plan. Plan's own session gets it through auto mode once T3 applies auto mode to
  Plan. Gateway Claude and Codex keep today's web behaviour, and say so, until T5 gives them a judge. Codex's
  `web_search` runs at OpenAI, out of the hook's sight, so it waits for T5 too.
- **T3's `judge` field is part of M2b's `AgentCapabilities`,** so T3 lands after M2b. T3 applies auto mode to lanes
  and passes on the built runner. Plan gets it in Sessions M4b, when Plan moves onto the explore engine, so
  Plan's session code is not rewritten twice.
- T4 follows T3. T5 follows T3, L1 and L5. T6 can land any time after T2.

## 13. Changes to the Sessions spec

The Sessions spec and its plans are revised on top of this before M2b's capabilities land. The changes:

- **S2, §7.1:** a chat is no longer read-only. "A chat that writes the repository" leaves the anti-goals.
- **S15, §7.3, Do it:**
  - Do It Here as a pass of one becomes optional ceremony: a chat writes in Your folder directly, holding the
    folder.
  - Do It in a separate copy stays.
  - The sealed-chat handoff stays only for the separate copy.
- **S14, §6.6:** the chat's builder tools are all present and judged; the "absent" rows go.
- **§7.1, what the agent gets:** setup per §6 here; web on; no `settingSources` call.
- **§17.4:** the calls on skills, web and settings are replaced by this design.
- **`AgentCapabilities`:** gains `judge`.
- **M5a, M5b:** the chat and Codex explore profiles become the attended profile here.

## 14. Live checks

Each is free or costs one turn.

Results are in `docs/architecture/research/2026-11-12-trust-line-research.md`.

1. **L1 (pass):** Codex app-server with `approval_policy: on-request` and `approvals_reviewer: auto_review`. The
   policy can be passed per thread (`thread/start` `config.auto_review.policy` and `approvalsReviewer`).
   - It judges a command without a client answer.
   - A custom policy is read.
   - Check what the model sees on a denial.
   - Check whether the builder's go-ahead in the thread changes the next verdict.

   Each passed, but Auto-review reviews only escalations (sandbox escapes, blocked hosts, MCP prompts), which 10db
   keeps closed, so it never sees a call inside the sandbox. This led to Codex on 10db's judge through the hook (§4).
2. **L2 (pass on a plan and Bedrock; gateway not run):** auto mode in a headless SDK session on a Claude plan, on Bedrock and on a gateway account. Check what
   the model sees on a block, and that the run continues.
3. **L3 (pass):** `plugins` loads an installed plugin (superpowers) and a generated skills dir with `settingSources: []`.
   Check that its hooks run, and where Claude Code lists installed plugins.
4. **L4 (partial):** Codex reads `SKILL.md` folders, including a Claude skills folder, and loads the checkout's
   `AGENTS.md` when the project is pinned `untrusted`. Skills load through `skills/extraRoots/set`, not
   `skills.config`; instructions go in `developerInstructions`.
5. **L5 (confirms L1's consequence):** Codex app-server with `approval_policy: on-request`,
   `approvals_reviewer: auto_review`, 10db's lane permission profile and the guard hook. Check that an `rm -rf` of a
   folder that existed before the turn runs with no review, that a `require_escalated` command reaches the guard
   hook first, and that three denials in a row interrupt the turn. T5's Task 0 needs it recorded.

## 15. Calls to review

1. **Attended and unattended:** conversations ask; tasks skip (§5).
2. **Plan writes no code** (§8): its role, not a security line.
3. **`.env` reads off by default**, with a switch (§9). The builder named reading secrets as a limit; this keeps
   them closed until a project says otherwise.
4. **Hooks from the builder's plugins don't run in 10db sessions yet** (§6, L3b): their answers can run a call the
   guard never judged and skip the broker.
5. **The builder's `~/.claude/settings.json` doesn't load** (§6): it can change billing and the sandbox.
6. **New network hosts are judged**, not carded, and kept per session unless the builder keeps them (§5).
7. **The `rules` floor** applies when no judge is available, and says so (§4).
8. **The judge is per live session**, inside M2b's `AgentCapabilities` (§4).
9. **Codex uses 10db's judge through the hook**, not Auto-review: Auto-review reviews only escalations, which stay
   closed in 10db, so it would never see a call inside the sandbox. Live check L5 confirms it (§4).
10. **Attended limits follow Claude Code:** soft denies the builder's go-ahead clears, and a card only where a
    call is escalated (§5).
11. **Run these now** is an unattended follow-up task, matched by intent (§5).
12. **Agent-written config** may be written, and runs only after approval (§5).
13. **Grants** are keyed on the limit and target in prose (§5).
14. **"Yours"** means the builder's home, not an account's config dir; OAuth MCP servers are a follow-up (§6).
15. **T2 before Sessions M2b; T3 after it;** web only where a judge exists until T5 (§12).
16. **The builder's own MCP servers run unsandboxed**, as in Claude Code, with calls judged; servers a
    repository declares stay sandboxed (§6).

## 16. Out of scope

- ACP agents (their own spec), which take 10db's judge when they come.
- Changing the gate's sandbox.
- A judge for the gate's commands: the gate runs the project's own command, not an agent's choice.
- Cloud sandboxes.
