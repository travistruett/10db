# What the builder allows runs as in Claude Code: their allow rule wins over the deploy rule

- **Date:** 2026-11-12
- **Amends:** `decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md` (item 6, "when in
  doubt, do what Claude Code does", applied to the guard's rules that T3 hands to a judge), and the T3 plan's
  call 10 (`docs/superpowers/plans/2026-11-12-10db-trust-t3-policy-and-auto-mode.md`).

## Decision

1. **A deploy covered by the builder's allow rule runs.** When a project's allowed commands (or another allow
   rule of the session) cover every segment of a command that deploys or publishes, the guard's PreToolUse hook
   settles the call itself, under every judge: no classifier (which `classifyAllShell` would otherwise hand it
   to) and no card stands in its way. Every other guard rule still applies to the line first: git and gh, hazards,
   claims, `sudo` and the file-access rules. With no allow rule, a judge that runs decides (and may escalate to a
   card); on the `rules` floor a deploy is refused as before.

## Why

- The builder's ruling on T3: "A deploy covered by a builder allow rule runs (the allow rule wins, as Claude
  Code)." In Claude Code an allow rule settles a matching call before auto mode's classifier; 10db's guard kept
  refusing what an allow rule would wave through, which made 10db stricter than Claude Code for an action the
  builder had approved in advance.
- An allow rule the builder typed is their go-ahead for the action. A lane can't write one: the allowed commands
  live in 10db's database, and a repo's `.claude/settings.json` never loads (R7).
- Turned down: leaving the call bare and letting the classifier judge it under `classifyAllShell`. The
  classifier would then refuse a deploy the builder allowed, which is the lockdown the trust line removes.
