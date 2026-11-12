# 10db trusts the developer and contains the agent: the sandbox is the security, a judge watches four limits, and nothing waits on the builder

- **Date:** 2026-11-12
- **Amends:** `decisions/2026-10-29-sandbox-is-the-boundary.md` (its "designed" item, trusting the sandbox and
  asking only about what it can't stop, becomes the rule for every surface),
  `decisions/2026-10-31-lanes-run-in-auto-mode-inside-the-sandbox.md`,
  `decisions/2026-11-03-plan-researches-the-web-through-a-researcher.md`,
  `decisions/2026-11-05-plan-runs-commands-and-project-tools-through-the-lane-broker.md`,
  `decisions/2026-11-05-codex-lanes-use-codex-sandbox-and-hooks.md`, and the factory spec's exclusion of
  user-level plugins (`docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md`). The design that carries
  it out is `docs/superpowers/specs/2026-11-12-10db-trust-line-design.md`.

## Decision

10db is a developer tool for people building their own projects. It trusts the developer and contains the
agent.

1. **The kernel sandbox is the security.** It stays as strict as it is, and a change to it keeps its adversarial
   review. Writes stay inside the checkout and the session's temp dir; credentials stay unreadable; code the
   agent runs reaches only the hosts the project allows. Config an agent writes never runs outside the sandbox
   without the builder's approval, since that is a way out of it.
2. **Four hard limits, defined by consequence.** An agent asks, or skips when nobody is there, before it:
   - destroys data it didn't create (a database, files that existed before the session, history);
   - sends data out to somewhere the builder didn't send it;
   - reads secrets (`.env` files, keys, credentials);
   - writes to anything live (a production deploy, a production database, a cloud account's resources).

   Everything else runs without asking: edits, installs, tests, the web, skills and MCP tools.

3. **A judge decides, not a rulebook.** Each adapter reports how its agent's calls are judged: natively (Claude
   Code's auto mode, Codex's Auto-review) or by 10db's judge. One provider-neutral policy states the four
   limits; each adapter translates it into its agent's own mechanism. Hand-written rules remain only as the
   floor when no judge is available, for the sandbox's integrity, and for coordinating 10db's own writers
   (claims, hazards, pages, the folder hold, landing). Coordination rules apply only where another writer can
   exist.
4. **A task that stops to wait on the builder is a bug.** In unattended work the agent skips an action that
   crosses a limit, finishes the rest, and leaves one Inbox item listing what it skipped and why. A task fails
   only when the skipped action was the whole job. In a conversation the builder is in, the agent asks inline
   instead.
5. **The builder's setup comes along by default**: their skills and plugins, their MCP servers (run as Claude
   Code runs them, with calls judged; servers a repository declares stay sandboxed), the project's instruction
   files, and the web. Each is a switch the builder can turn off, per
   project or app-wide.
6. **When in doubt, do what Claude Code does.** A restriction Claude Code doesn't have needs a stated reason
   tied to a hard limit or to coordination. Specs say which; plan review checks it, as it checks provider
   parity.
7. **The same on every provider.** The policy, the switches and the unattended rule are the same on a Claude
   plan, Bedrock, an API key, a gateway and a ChatGPT plan. Where a provider's judge or tool is missing, the
   feature runs with 10db's judge or says what it lacks.

## Why

- **The friction was in the layers, not the sandbox.** An inventory on 2026-11-12 found about 130 restrictions
  across lanes, the gate, Plan, passes and the designed Sessions chat. Most were copied from one surface to the
  next without asking whether the new surface needed them: Plan's read-only, web-through-a-researcher and
  no-settings lines became the chat's by default. `decisions/2026-10-29-sandbox-is-the-boundary.md` already
  found that the security model was sound and the layers on top "were strict in the wrong places"; this
  decision applies that finding everywhere.
- **The builder's own words.** "This is an alpha developer tool. Developers expect to be trusted and have
  power." "If it's too rigid, I'm never gonna use it and people are never gonna use it." "If I have to
  constantly babysit this, it defeats the entire point." And on Claude's auto mode: "it just knows when to
  prompt me in a really intelligent way."
- **The judges already exist.** Claude Code's auto mode blocks, by default, sending sensitive data out,
  production deploys and migrations, irreversibly destroying files that existed before the session, force
  pushes and `curl | bash`, and treats hosts named `prod` or `production` as sensitive. In a headless run a
  blocked action doesn't run and the agent keeps working. It runs on every Claude plan, the API, Bedrock and
  Vertex on current models. Codex's Auto-review checks for exfiltration, credential probing, weakening
  security and destructive actions, with a replaceable policy file. Sources:
  `docs/architecture/research/2026-11-12-trust-line-research.md`.
- **Prior art.** Multi-provider harnesses (Pi, OpenCode) trust the developer fully and load Claude-style
  skills, but ship no sandbox. Factory states that "command rules are not operating-system isolation".
  Orchestrators that run unattended (Factory's `droid exec`) stop at the first action above their level; none
  found skips and continues. 10db keeps the freedom and adds a real boundary underneath.
- **Turned down:**
  - Keeping the lockdown and adding opt-in "power" switches: the default is what everyone feels, and a
    default nobody wants is a bug.
  - Removing the sandbox to match Pi: the four limits need a floor that a judge's mistake can't cross.
  - One rulebook shared by every provider: rules can't tell a harmless command from a dangerous one that looks
    the same, so they ask about both (`decisions/2026-10-29-sandbox-is-the-boundary.md` records six review
    rounds chasing shell tricks).
  - Pausing an unattended task when the judge would ask: that is babysitting by another name.
