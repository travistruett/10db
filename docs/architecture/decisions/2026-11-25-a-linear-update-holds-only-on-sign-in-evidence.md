# A Linear update is held for a sign-in only on evidence that the account needs one

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-25-linear-updates-hold-on-the-projects-own-account.md`

## Decision

A reporter run that leaves rows open without one Linear call that answered is no longer, by that alone, an
account that can't reach Linear. `linear/reporter-reach.ts` (`reachOutcome`, pure) decides, in this order:

1. A Linear call of the run answered: the run reached Linear, and its rows fail as any run's do.
2. A Linear call of the run failed with an auth error (401, unauthorized, unauthenticated, `invalid_token`,
   authentication required, needs auth, in its error or result): held for a sign-in.
3. The guard allowed a Linear call: the run reached Linear, and its rows fail.
4. The account's sign-in check says signed out (`checkSaysSignedOut`: a checked `LinearVia.None`, or a read
   of its server that says not signed in, `signedIn: false`): held.
5. The session had no Linear server: held.
6. The check says signed in, or a Linear call answered earlier in the same Reporter conversation (the newest 200
   items) in a session on the run's account: the rows fail with a try spent, and the reason says why this isn't
   a sign-in (`noLinearCall`). The account is not taken as signed out, so its other tasks still run.
7. Otherwise (a Claude account whose check can't read its server and whose conversation never answered): held.

A call is on Linear when `mcp__<mcpToolPrefix(server)>__` is one of the run's Linear prefixes. The `server`
field of a tool call is the same on Claude and Codex.

Also:

- A pickup and a snapshot hold, or answer missing, on `checkSaysSignedOut`, which includes `signedIn: false`.
- A Codex account's `signedIn` (`daemon/linear-sign-ins.ts`) is true when a Linear server reads signed in, false
  only when every one reads not signed in, and null otherwise: a status that couldn't be read (a timeout immediately
  after a restart, Codex still answering `unknown`) or a sign-in under way or ended in error says nothing, so the
  run goes ahead and the rule above decides. Settings then shows such a row its switch, not Connect Linear.
- Earlier answers count only from the account's own sessions. A task's one Reporter conversation outlives a move,
  and its sessions name their account: `accountRunStart` finds where the unbroken run of newest sessions on the
  run's account began (the newest 50), and only calls since then count. A project moved to a Claude account that
  isn't signed in is therefore held, naming that account, as the amended decision says.
- An allowed Linear call forgets the account's in-memory signed-out note, as does a pickup whose check says
  signed in.
- A `failed` report from a run that reached no Linear follows the same rule; when it spends a try, the reason
  carries what the session said.
- A run's first message names its tools in full (`runToolNames` in `reporter-guard.ts`) and says to search for
  one by that name when it isn't listed.

## Why

On 2026-11-25 a signed-in Codex account's updates were held with "isn't signed in to Linear", and the account
was taken as signed out for 30 minutes, holding another task's rows untried. The sign-in check said
`signedIn: true`, and the same conversation's snapshot turn had read the issue a minute before. The posting turn
was a fresh session with its write and report tools (`keepsResume` is false, `begin` opens a `ReporterRun` with
`readOnly` false); its model answered with a footer and called nothing. A turn that calls nothing is no evidence
of a missing sign-in.

Alternatives turned down:

- **Holding a run whose tools were missing (the 21:29Z case: no Linear or 10db tools listed after a restart)
  with a setup reason.** From the run alone 10db can't tell "the tools were missing" from "the model didn't
  call them", and a hold would repeat every 30 minutes under a label that isn't true. It spends a try instead,
  and finding why the tools were missing is its own task.
- **Reading which servers need a sign-in from each session adapter.** Still turned down for now: the evidence
  above works the same on every provider. If it proves too weak on Claude, a follow-up adds it.
