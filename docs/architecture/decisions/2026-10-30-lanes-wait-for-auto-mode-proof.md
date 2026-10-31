# Lanes move to auto mode only after the live test proves it, and stay in default mode until then

- **Date:** 2026-10-30
- **Amends:** decision 124 ("auto mode is gone")

## Decision

The builder chose to run lanes in Claude Code's auto mode under the lane sandbox. It takes effect
only once the live test shows that, in auto mode, every call 10db must see still reaches it. Until
then every lane stays in `default` mode, as decision 124 says.

What is built:

- `createClaudeAdapter` takes `lanePermissionMode` (`'default'` or `'auto'`). It applies only to a
  sandboxed session. An unsandboxed one, which only scripted tests start, always runs in `default`.
  When it is unset, the adapter uses `LANE_PERMISSION_MODE` in
  `apps/daemon/src/sessions/claude-adapter.ts`, which is `'default'`. Only the live test sets it.
- The PreToolUse hook answers with `judgePreToolUse` (`apps/daemon/src/guard/pre-tool-use.ts`), in
  every mode. It gives the guard's verdict, and `ask` for a call the guard allows that the broker
  must still see:
  - a Bash command that may run a hazard the task hasn't claimed but that the guard can't read:
    `hazardHit` or `firstUnread` over the unclaimed hazards that have commands finds something. That
    covers a hazard behind a variable (`SUB=add; pnpm $SUB left-pad`), a program named by a variable
    or a glob (`$PM add`, `/usr/bin/p?pm add`), and an unread script or structure. Once the task
    holds every hazard that has commands, there is nothing left to ask about;
  - every `Monitor` call. The guard doesn't judge a Monitor command, and Monitor's `ws` opens a
    WebSocket from Claude Code's own process. The broker runs a lane's watch of its own task output
    without a card (`decisions/2026-10-30-lane-monitor-of-its-own-task-output.md`) and cards the rest;
  - every `WebFetch`, which reaches its host from Claude Code's own process, outside the sandbox's
    network proxy and its per-host card. The broker answers it from a stored rule or a card.

  Claude Code sends a hook's `ask` to `canUseTool` even where an allow rule covers the call. In
  default mode all of these reached the broker already: none is on the allow list, except a command
  a project's `allowedCommands` prefix covers, which now reaches the broker too.

  The hook also refuses a Bash or Monitor call whose `allowed_domains` is not empty. The Claude Code
  that ran the lane that built this offers that field on both tools ("Auto mode only: the list is
  reviewed together with the command and, if approved, applies to this one command"); the SDK's
  typings, for Claude Code 2.1.310, don't list it yet. In auto mode the classifier alone
  would review it and the sandbox would let the command reach those hosts, with no network prompt
  and no card. In default mode Claude Code ignores the field, so the refusal costs only a retry
  without it. WebSearch's field of that name only filters results and is left alone.

- In auto mode the hook, the `ask` rules for Claude Code's protected files, `disallowedTools` and
  `canUseTool` (the permission broker) are all still wired. A call Claude Code marks as needing a
  person (`requiresUserInteraction`, or `decisionReasonType: 'classifier'`) arrives as `escalated`
  and always becomes a card: no stored rule or carried allowance answers it, as decision 103
  described. Unit tests in `apps/daemon/src/inbox/inbox.test.ts` already cover it.
- `apps/daemon/test/lane-sandbox.live.test.ts` has a block, "lane sandbox in auto mode, live", that
  runs the real Claude Code (on sonnet) in auto mode under the lane sandbox. Each card is denied as
  it opens.
  1. **Hazards however spelled, and ask rules.** The lane holds an area but no hazard. A Write into
     `db/migrations/` is refused by the guard. A Write to `.mcp.json` (an `ask` rule) reaches the
     broker and becomes a card. `pnpm add left-pad@1.3.0` is refused by the guard.
     `SUB=add; pnpm $SUB left-pad@1.3.0` gets the hook's `ask`, reaches the broker and becomes a
     card. A Monitor whose command is `pnpm add left-pad@1.3.0` gets the hook's `ask`, reaches the
     broker and becomes a card. No file is written and nothing is installed.
  2. **Claude Code's own network.** `WebFetch` of `https://example.net/` and a `Monitor` with `ws`
     `wss://example.net/`, a host the project doesn't list, each get the hook's `ask`, reach the
     broker, become one card naming the host, and are refused before they run. The page never
     reaches the session. A `curl` of the same host, asked for with `allowed_domains`
     `["example.net"]`, is refused by the hook; a Claude Code without the field runs it and the
     sandbox's prompt cards the host. Either way the host is never reached.
  3. **New hosts.** `example.com` and `example.org`, which the project doesn't list, reach
     `canUseTool` as `SandboxNetworkAccess`. They raise exactly one card per host, though
     `example.com` is asked for by two commands.
  4. **Escalation.** A command that posts `.env` to an allowed host reaches the broker marked
     `escalated`, becomes a card and is refused.
  5. **No cards for routine work, and each call ran.** These are the kinds of command that raised
     cards on 2026-10-30: a background command watched with Monitor, WebSearch,
     `grep -n 'fixture$' README.md`, `diff3` on files in `$TMPDIR`, and
     `pnpm exec drizzle-kit generate` by a lane holding the migrations hazard. None raises a card or
     a guard refusal, and each ran: grep's result holds `1:# fixture`, diff3's holds `====`, the
     Monitor and WebSearch results are not errors, and drizzle-kit's result is no refusal (a missing
     drizzle-kit or `package.json` is fine).

To run them, on a machine signed in to Claude Code (never in CI or a lane):

```sh
TENDB_LIVE_CLAUDE=1 pnpm --filter @10db/daemon exec vitest run test/lane-sandbox.live.test.ts -t 'auto mode'
```

**What switching needs.** All five cases pass. Then a follow-up change sets `LANE_PERMISSION_MODE`
to `'auto'`, updates the unit test that expects `'default'`, and records a decision that supersedes
124's "auto mode is gone" with the results.

- Cases 1 and 2 show whether Claude Code holds a hook's `deny` and `ask`, and an `ask` rule, ahead
  of the classifier. If either fails, a hazard or a host would skip 10db: lanes stay in `default`
  mode and the follow-up decision records the bypass.
- Case 3 shows whether the sandbox's prompt for an unlisted host reaches `canUseTool` in auto mode.
  If it fails, lanes stay in `default` mode and the follow-up records it.
- If only case 4 fails because the classifier refuses the call outright and no card is raised, the
  call still never runs. The builder decides whether that is enough.
- If case 5 fails, auto mode doesn't remove the cards it was chosen to remove. The builder decides
  whether to switch anyway.

**What auto mode moves from 10db's cards to the classifier.** These raise a card in default mode
today and would go to the classifier after the switch, with no card:

- A command that runs a hazard the task holds, such as `pnpm exec drizzle-kit generate` with the
  migrations claim. The broker cards every hazard hit, claimed or not.
- A read outside the checkout and the project's read list (`Read`, `Grep`, `Glob`, `LS`; the
  broker's `ask` by real path). The kernel sandbox covers Bash, not Claude Code's own file tools,
  so a lane could then read a file elsewhere in the builder's home that isn't a protected path if
  the classifier approves. Protected paths are still refused by the guard in any mode.
- `WebSearch`, which runs on Anthropic's side and reaches no host from this machine.
- The tools of an approved repo MCP server, which the allow list doesn't name. Each stdio server
  runs under srt with only the hosts its approval names. A remote one is reached at its approved
  URL.
- Any other tool the allow list doesn't name that Claude Code asks about.

The follow-up that switches records whether the builder accepts each of these.

## Why

Decision 124 removed auto mode because its classifier approves calls itself, and they never reach
10db's broker. In default mode the guard's allowlist decides everything, so routine commands it
doesn't know each become a card. On 2026-10-30 a dozen such cards stopped lanes, and none was
something 10db needed to stop. The builder trusts the classifier for routine calls, as in their own
sessions. Decision 121 named the way back: auto mode under the sandbox, with `ask` rules for what
must still ask.

Two kinds of call must still reach 10db. One is a hazard hit, so a lane claims migrations, deps or
harness before it touches them. The other is a new network host, one card per host.

A hazard reaches 10db by three paths, and only one held in auto mode without a change. A hazard
spelled out in plain words is refused by the guard's hook. A hook's deny should hold in any mode,
but nobody has checked it in auto mode. A hazard the guard can't read, such as one behind a
variable or a glob, reached 10db only through the broker's card.
`decisions/2026-10-28-broker-unread-arguments.md` added that card because `$CMD add left-pad` had run with no
card, and in auto mode the classifier would decide it instead. A Monitor command is not judged by
the guard at all. So the hook now asks about both.

A new host reaches 10db by the sandbox's network prompt to `canUseTool`. Two tools reach hosts
without that prompt: `WebFetch` and Monitor's `ws` both connect from Claude Code's own process. In
default mode neither is on the allow list, so each became a card; in auto mode the classifier would
decide them. So the hook asks about them too. The SDK's own note on the sandbox's strict allowlist
says in-process tools such as WebFetch are not gated by the sandbox's network settings. A third way
around the prompt is a command's own `allowed_domains`, which only auto mode reads, and which the
classifier alone reviews. The hook refuses it.

Nobody knows how Claude Code orders `ask` rules, hook decisions and the classifier in auto mode, or
whether it sends the sandbox's network prompt there. The SDK's typings list `hook` and `rule` among
the reasons auto mode hands a call to `canUseTool` (`decision_reason_type`), which suggests both
hold, but only the live test shows it. The task required proof against the real Claude Code before
switching.

The lanes that built this could not run the proof. Their sandbox denies `api.anthropic.com`
("deny network-outbound api.anthropic.com:443") and reads of `~/Library/Keychains` and
`/usr/bin/security`, so `claude` cannot sign in there. It also denies reads of Claude Code's own
install (`~/.local/share/claude/versions`), so the ordering couldn't be read from its code either.
The live test also nests srt inside that sandbox. Asked how to proceed, the builder chose: write
the tests now, keep lanes in default mode, and switch in a follow-up once the tests pass on the
builder's machine.

Turned down:

- **Switch now and run the tests before merge.** This breaks "prove before switching". If the
  classifier waved a hazard or a host through, every lane would skip 10db until someone noticed.
- **A per-project or env switch.** Decision 124 removed both because a Finder-launched app can't
  reach an env switch, and the builder wants one way to run. The adapter option is for the live
  test only. Nothing in the daemon sets it.
- **Have the guard refuse a command it can't read.** That holds however Claude Code orders hooks and
  the classifier. But it refuses, in every mode, a call the builder can approve on a card today. An
  `ask` keeps today's card.
- **Ask only in auto mode.** The guard would have to know the mode. In default mode the `ask`
  changes nothing but a command an `allowedCommands` prefix covers, which should reach the broker
  anyway.
- **Wait for the live test before adding the `ask`.** The classifier is built to approve routine
  work, and a plain install or a fetch of a public page looks routine. Without the `ask`, cases 1
  and 2 would most likely fail and need another round before the switch.
