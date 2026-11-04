# A start with no account is checked with `claude auth status` before the account is paused

- **Date:** 2026-11-03
- **Amends:** `decisions/2026-10-30-a-slow-start-is-not-a-signed-out-account.md`

## Decision

- **The check.** When a start of a subscription account gets no account from Claude Code (no answer in time, or
  `accountInfo()` rejected), the session runs `claude auth status --json` with the session's own env, which
  names the account's config directory (`claudeAuthStatus` in `sessions/sign-in-check.ts`, 20 s limit). It reads
  `loggedIn`: `signed_in`, `signed_out`, or `unknown` for a failure, a timeout or output it cannot read. A keyed
  account has no sign-in to check and is not asked.
- **Signed out.** `signed_out` refuses the account at once, on the first silent start, as a `signed_out` refusal.
  The card is the same sign-in card as before and names the sign-in command; its message now says `claude auth
status says it is not signed in, so it looks signed out`.
- **Signed in or unknown.** The session starts Claude Code again, with a longer wait and after a pause: waits of
  30 s, 60 s and 120 s (`START_WAITS_MS`), pauses of 10 s and 30 s before the second and third start
  (`START_BACKOFF_MS`). A stop during a pause ends the session as stopped. The runner sees one session, as before.
  Nothing is paused and no card is raised while a start still has a retry left.
- **Bounded.** When the third start is silent too, a subscription account is refused with the new
  `AccountProblem.StartTimeout` (`start_timeout`): `... but claude auth status says it is signed in (or: gave no
answer), so its starts kept timing out`. Its card says to answer Resume once the load settles, and names the
  sign-in command in case the account is signed out after all. A keyed account fails the step with a billing
  refusal after the same starts, as before.

## Why

On 2026-11-03 the card "Claude plan: sessions refused" said Claude Code reported no account within 30 s on each
of 2 starts, "which looks signed out". `claude auth status` showed `loggedIn: true` and the load average was
20-30; sessions started fine minutes before and after. Two silent 30 s starts are evidence about the Mac, not
the account, and the pause stopped every lane until the builder answered Resume.

`claude auth status` reads the login without starting a model session, so it answers when a full start does not,
and it is the direct answer to "is this account signed out". Turned down: only lengthening the waits (a real
sign-out would then take minutes to notice and the card could still say signed out for a signed-in account); a
new session outcome for the runner to retry (the failure happens before the prompt, as the 2026-10-30 decision
found); reusing `signed_out` for the bounded timeout (its card tells the builder to sign in again, which is wrong
for a signed-in account).
