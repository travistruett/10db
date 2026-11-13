# What the builder allows runs as in Claude Code: their allow rule wins over the deploy rule, and a pass asks before it reads `.env`

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

2. **In a pass, a Read of the checkout's `.env*` files asks the builder.** Where the builder is in the session, a
   Read of one of the checkout's own `.env*` files (a file, or a file in a `.env*` folder, whose real path is in the
   checkout) gets a card the builder can allow, as in Claude Code, instead of a refusal: Claude Code holds it as an
   `ask` rule rather than a deny rule, and the guard and the broker card it. A lane still refuses it. The kernel
   still denies `.env*` to commands, a Grep, Glob or LS over one is still refused, and a `.env*` link that leads out
   of the checkout stays a protected read. A key file in the checkout is no secret 10db lists, so its Read is left
   to the judge, whose reads-secrets limit is a soft deny in a pass that Allow this can clear. Credential stores
   outside the checkout (`~/.ssh`, the Keychain, account config) stay unreadable in every session, as decision item
   1 of the trust decision keeps them.

## Why

- The builder's ruling on T3: "A deploy covered by a builder allow rule runs (the allow rule wins, as Claude
  Code)." In Claude Code an allow rule settles a matching call before auto mode's classifier; 10db's guard kept
  refusing what an allow rule would wave through, which made 10db stricter than Claude Code for an action the
  builder had approved in advance.
- An allow rule the builder typed is their go-ahead for the action. A lane can't write one: the allowed commands
  live in 10db's database, and a repo's `.claude/settings.json` never loads (R7).
- Turned down: leaving the call bare and letting the classifier judge it under `classifyAllShell`. The
  classifier would then refuse a deploy the builder allowed, which is the lockdown the trust line removes.
- The builder's ruling on T3: "In a pass, `.env` and key reads keep the soft-deny card. Make sure it is a card the
  builder can allow, not a hard refusal." A pass's `.env` read was refused three times over (Claude Code's deny
  rule, the guard and the broker), so no go-ahead could clear it. The Read tool runs in Claude Code's process, not
  in the kernel sandbox, so a card on it opens the file only for the call the builder allowed.
- The spec's fuller design (trust line §2: attended sessions kernel-readable, with the limit line judging each
  read) needs the sandbox profile to differ by surface and its adversarial review; this keeps the profile as it is
  and opens only the Read tool, behind a card.
