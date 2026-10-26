# 04 Accounts

- **Status:** Locked
- **Scope:** Who pays for each project's sessions: accounts, how a session proves it runs on its account, per-account concurrency, pauses and monthly caps, usage, moving a project between accounts with work in flight, and how agents are kept from credentials.
- **Summary:** The design is `docs/superpowers/specs/2026-10-17-10db-accounts-design.md`, with spike 12's findings in `docs/architecture/research/spike-12-accounts.md`; its decisions and the plan's are rows 105–118 of `decisions.md`. Changes are new rows that name what they supersede.

## Where it lives

| Module                                      | Job                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db` `accounts`, `store/usage.ts`  | one row per account; projects and sessions bind to one; usage is a query over sessions                                                                                                                                                                                                                            |
| `apps/daemon/src/environment/`              | the Keychain (`keychain.ts`) and the launcher (`launch.ts`): the only code that names account variables; the project env for gates and repo MCP servers; the Claude Code version warning                                                                                                                          |
| `apps/daemon/src/sessions/account-check.ts` | what a session must report before its prompt and at its first `init`; both adapters use it                                                                                                                                                                                                                        |
| `apps/daemon/src/accounts/`                 | pauses, the monthly cap, readiness and the preparer, staggered subscription starts, cards and their answers, the service behind the HTTP routes, moving a project (`moves.ts`), the move back (`move-back.ts`), the latest usage reports (`usage-reports.ts`) and the fallback at a usage threshold (`limits.ts`) |
| `apps/daemon/src/runner/`                   | reads the project's account before each session; a lane whose conversation ran on another account starts fresh from its handoff (`next-action.ts`); `handOff` nudges a project's lanes on an account                                                                                                              |
| `apps/daemon/src/guard/account-rules.ts`    | Keychain commands, environment dumps, credential variables, the data directory and the default account's sign-in (`~/.claude`, `~/.claude.json`, the login shell's config directory) are refused in every step kind, as interim policy until the lane sandbox is built (`03-trust-boundaries.md`)                 |
| `apps/desktop`                              | the new-project form's account, and Settings' Billing account and fallback pickers; the Accounts screen is plan 12                                                                                                                                                                                                |

## Invariants

- A session sends its prompt only after `accountInfo()` matched the account's identity and credential kind; a mismatch pauses the account with a card and sends nothing. A model mismatch fails the workstream, not the account.
- The default account runs on the builder's own login (the login shell's `CLAUDE_CONFIG_DIR`, else Claude Code's default directory); every other account, keyed kinds included, runs on its own config directory under the data directory.
- An unready account (no confirmed identity, no secret) is prepared, never refused: its work waits `QUEUED`.
- A keyed account's secret is read from the Keychain at every start and must match the fingerprint 10db recorded; it is never in the database, a log, an event, a card or a response.
- An account's lanes, usage limits and monthly cap apply only to that account; a capped or refused account lets running sessions finish.
- The gate and the repo's MCP servers never get an account's credentials.
- Nothing billing-related comes from the login shell.
- On a subscription account, sessions start one at a time until the refresh question in `open-questions.md` is answered.
- A project is on exactly one account at a time. A move applies at each lane's next session; no lane resumes a conversation from another account's config directory, it starts fresh from its latest handoff.
- Nothing moves a project without the builder except its own fallback, which must be ready, and capped when metered; a project with no work in flight never moves on its own; the way back is always the builder's choice.

## Known and accepted

- Right after a move, the old account's lane count drops while its sessions still run, so another project can briefly run more lanes there than its `laneCap`, until those sessions end.
- Claude Code reports usage short of the limit only for subscription accounts, so the usage threshold moves a project early only from a subscription; a keyed account moves its projects at the hard limit.
- A lane that moves starts fresh from its latest handoff: context that was neither committed nor handed off stays behind (open question: carrying the conversation across accounts).
- A paused revise or uncommitted session that moves to another account, or resumes after a failed resume, loses its instruction; the review notes still appear under Earlier steps.
- A move-back card answered Later is asked again after a restart. When a reset time was reported and it has passed, the move back fires at restore; when none was reported, each restart restarts the move-back wait.
- Three records live in memory, so a restart can repeat a card once: the projects an account's current pause has carded (a project can be carded once more), the usage threshold crossings already acted on (the builder can be asked once more) and the projects given a cap card (a dismissed cap card returns once).
- A high usage report whose reset time is already past, from clock skew near a window boundary, counts as a new crossing until the window rolls.
- What a session can and cannot reach, and what keeps it from other accounts' credentials, is `03-trust-boundaries.md`. Until the lane sandbox plan is built, the guard's Keychain, environment and path rules are interim policy. The parked Task 7 findings are recorded there: Task 7R fixed some, and the rest close as moot once the lane sandbox is built. Until then those shapes are live.
