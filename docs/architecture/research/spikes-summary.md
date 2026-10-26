# Spikes summary (pre-M1)

- **Status:** Complete for spikes 1–7 and 9; spike 10 optional (PARTIAL); spike 8 runs in M1b; spike 11 ran in M0.
- **Date:** 2026-10-15
- **Versions:** claude 2.1.300 (Claude Code) · Agent SDK 0.3.299 · Node v25.2.1

| #   | Spike                                                 | Status   | Consequence for M1                                                                                                                                                           | Note                                          |
| --- | ----------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | SDK runs installed claude; user settings excluded     | VERIFIED | M1b: `which claude` + `settingSources: ['project']` + `strictMcpConfig`; billing check is `none` / `firstParty` / non-empty `subscriptionType`; built-in plugins always load | [spike-01](spike-01-runtime.md)               |
| 2   | Context usage readable after each turn                | VERIFIED | M1b: context = `100 × totalTokens / maxTokens` per assistant message; models report a 1M window                                                                              | [spike-02](spike-02-context-usage.md)         |
| 3   | Compaction control                                    | VERIFIED | M1b must set `settings: { autoCompactEnabled: true }` explicitly; PreCompact never blocks                                                                                    | [spike-03](spike-03-compaction.md)            |
| 4   | Per-session MCP config carries headers                | VERIFIED | M1a: stateless HTTP `/mcp` with bearer token, no stdio shim; M1b: repo tools gated by `canUseTool`, stdio via `env -i`                                                       | [spike-04](spike-04-mcp-headers.md)           |
| 5   | Questions and permissions reach canUseTool            | VERIFIED | M1a: question card maps 1:1; "always for this project" is stored by 10db, not as the SDK's `localSettings` suggestion                                                        | [spike-05](spike-05-questions-permissions.md) |
| 6   | Long wait: end cleanly, resume with answer            | VERIFIED | M1a: hold up to 10 min, then deny with `interrupt: true`; resume keeps the session id; the parked end is an error result                                                     | [spike-06](spike-06-park-resume.md)           |
| 7   | Usage-limit signal shape                              | PARTIAL  | M1b: `resetsAt` is seconds; `rejected` handling designed from the types (not observed)                                                                                       | [spike-07](spike-07-usage-limits.md)          |
| 9   | caffeinate -w tied to daemon pid                      | VERIFIED | M1b keep-awake: `caffeinate -i -w` on the daemon pid, self-releases in about 50 ms                                                                                           | [spike-09](spike-09-caffeinate.md)            |
| 10  | claude --bg surface (optional)                        | PARTIAL  | none for M1                                                                                                                                                                  | [spike-10](spike-10-bg-daemon.md)             |
| 13  | Bash sandbox (`Options.sandbox`) as the lane boundary | PARTIAL  | Engages through the SDK; Read tool, hooks and MCP stay outside it; unlisted hosts ask `canUseTool`; `make gate` cannot fully pass inside it (`ps`, git repos under the cwd)  | [spike-13](spike-13-sandbox.md)               |

## Constants for M1b

Required. Fill every row with one value, or with `UNKNOWN` plus the fallback M1b uses. The first eight rows match
the first seven rows of the spike-dependent table at the top of the M1b plan; its pass-through row is split in two
here.

| Constant or behavior                                                                                            | Value                                                                                                                                                                    | M1b assumed                                                                       | Spike |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ----- |
| Context percentage scale (`SCALE=` line) and denominator                                                        | 0-100 of maxTokens, `percentage` rounded to an integer; `maxTokens` 1,000,000 for haiku and sonnet unless `autoCompactWindow` is set                                     | computed as `100 × totalTokens / maxTokens`                                       | 2     |
| `resetsAt` units                                                                                                | s                                                                                                                                                                        | below 10¹² = seconds                                                              | 7     |
| MCP HTTP `headers` reach the server on every request                                                            | yes, including `server/discover` and the handshake                                                                                                                       | yes (else a stdio shim before M1b Task 3)                                         | 4     |
| `canUseTool` is called for passed-through repo MCP tools (`mcp__<server>__<tool>`)                              | yes for both transports: http, stdio, when no settings-file allow rule covers the tool (project `.claude/settings.json` allow rules can shadow the callback; not tested) | yes for both (else stop before M1b Task 3)                                        | 4     |
| A stdio server launched as `/usr/bin/env -i PATH=… HOME=… <command>` sees only those keys (`STDIO_ENV_I_KEYS=`) | `HOME,PATH,__CF_USER_TEXT_ENCODING` (the last set by macOS inside the process; no session variable)                                                                      | `HOME,PATH` (else stop before M1b Task 3 if a session variable appears)           | 4     |
| `AskUserQuestion` single-select answer format                                                                   | `updatedInput: { ...input, answers: { [question]: label } }`                                                                                                             | `updatedInput.answers[question] = label`                                          | 5     |
| A stopped session resumes with `resume`                                                                         | yes, via both deny-interrupt and abort                                                                                                                                   | yes                                                                               | 6     |
| `caffeinate -i -w <pid>` exits when the pid exits (orphaned child too)                                          | yes, 51 ms (SIGTERM) / 50 ms (SIGKILL)                                                                                                                                   | yes                                                                               | 9     |
| `autoCompactThreshold` as % of `maxTokens`                                                                      | 96.7% on the 1M window (967,000); 83.5% with `autoCompactWindow: 200000` (167,000); absent while auto-compaction is off                                                  | above 85%                                                                         | 2     |
| `getContextUsage({ detail: 'summary' })` works mid-turn; latency                                                | yes; 4–16 ms summary / 478–750 ms full                                                                                                                                   | yes, once per assistant message                                                   | 2     |
| `alwaysLoad: true` needed for the `10db` server                                                                 | no (`ALWAYS_LOAD_NEEDED=no`)                                                                                                                                             | set to true                                                                       | 4     |
| MCP server status at `init`                                                                                     | connected                                                                                                                                                                | not relied on                                                                     | 4     |
| `canUseTool` `mcpServer.source` for servers passed in `mcpServers`                                              | `dynamic`                                                                                                                                                                | not relied on                                                                     | 4     |
| A stdio server's declared `env` merges with the session env (`STDIO_ENV_INHERITS_SESSION=`)                     | yes, and Claude Code adds `CLAUDE_CODE_MESSAGING_TOKEN` and other keys                                                                                                   | yes, from Claude Code 2.1.300's bundle; M1b's `env -i` launch is right either way | 4     |
| A declared `env` keeps `PATH` (`STDIO_ENV_KEEPS_PATH=`)                                                         | yes                                                                                                                                                                      | not relied on: `env -i` passes `PATH`                                             | 4     |
| `mcp__10db__*` also matches a server named `10db__x` (`TENDB_RULE_MATCHES_10DB__X=`)                            | no                                                                                                                                                                       | not relied on: M1b drops such names                                               | 4     |
| Subscription `apiKeySource` / `apiProvider` / `subscriptionType`                                                | none / firstParty / `Claude Max` (a display string; `claude auth status` says `max`)                                                                                     | none / firstParty                                                                 | 1     |
| `['project']` excludes user and local settings; project settings load                                           | yes; project hooks ran with no trust prompt; but the builder's `autoCompactEnabled: false` still applied (inferred to come from the global `~/.claude.json`)             | yes                                                                               | 1     |
| SessionStart(`compact`) re-injection reaches the model                                                          | yes                                                                                                                                                                      | yes                                                                               | 3     |
| Overage fields seen; overage enabled on the account                                                             | `overageEnabled`, `overageStatus` (`rejected`), `overageDisabledReason` (`out_of_credits`), `isUsingOverage` (false); enabled but out of credits                         | `isUsingOverage` treated as `rejected`                                            | 7     |
| `AskUserQuestion` multi-select, free-text ("Other") and `annotations.notes`                                     | `, `-joined labels, free text and notes all reach the model                                                                                                              | note appended to the answer string                                                | 5     |
| Resumed session id                                                                                              | same                                                                                                                                                                     | either; the adapter stores whatever `init` reports                                | 6     |
| Longest verified pending `canUseTool` hold                                                                      | 600,001 ms                                                                                                                                                               | 10 minutes                                                                        | 6     |
| Orphan fencing needed after an abort                                                                            | no (no claude pid or group member survived either park)                                                                                                                  | recovery fences any live pid                                                      | 6     |
| `accountInfo()` answers before the first prompt on a Max login                                                  | yes: 587 ms with no prompt sent, `apiProvider: firstParty`, `subscriptionType: Claude Max`; `init` does not arrive until a prompt is sent                                | yes, within 15 s                                                                  | 1     |
| A session's baseline context, before any work                                                                   | about 18k tokens in a bare fixture repo: 1.8% of 1M, 9.1% of 200k (a 10db session adds its MCP tools and context pack)                                                   | below 12% on a 200k window                                                        | 2     |

## M1b plan changes required

Applied on 2026-10-15 to the M1b plan (and, where noted, to the M1a plan and the spec), with the builder's
decisions on items 3–5.

1. **Applied. Task 3 `buildQueryOptions` sets `settings: { autoCompactEnabled: true }`,** with a matching
   assertion in its first test. The builder's `autoCompactEnabled: false` (inferred to come from the global
   `~/.claude.json`) reaches the session under `settingSources: ['project']`. Decision 40 (compaction as the
   emergency fallback) depends on it. Spike 3.
2. **No change needed: compaction re-injection.** M1a's runner already handles the `compacted` event: it records
   a deviation and re-sends the context pack (`compactionReinjection`). No PreCompact block is used. A
   `SessionStart(source: 'compact')` callback returning `additionalContext` is a working alternative that injects
   at the compaction point itself (spike 3), if the runner's follow-up message ever proves too late.
3. **Applied. Context thresholds default to 40 / 50** (about 400k / 500k tokens on the 1M window). The builder
   finds output quality stays higher with a fresh session around 400–500k than with one run toward the limit,
   and compaction wastes tokens. `autoCompactWindow` stays unset, so `maxTokens` is 1M and auto-compaction (96.7%)
   is a safety net a 40% handoff should never reach. Changed:
   - the spec (§ handoff steps and §15);
   - M1a's schema defaults, its constraint line and two tests;
   - M1b Task 11's `DEFAULT_HANDOFF_PCT` / `DEFAULT_NUDGE_PCT` (`nudgeFor(40)` is now 50), plus the fixture and
     form test that repeat the defaults.

   Tests that pass thresholds explicitly keep their values. If a 200k window is ever set, `nudgePct` must sit
   below 83.5%, or compaction fires first. Spikes 2 and 3.

4. **Applied. Task 14 live acceptance uses `handoffPct` 5 / `nudgePct` 6,** the schema's integer minimums (50k /
   60k tokens on the 1M window), instead of 12 / 20, which assumed 200k. The bare baseline is 1.8%; the run
   reports a 10db session's (`sessionBaselines`), and its troubleshooting step now compares against 5%. Spike 2.
   The first live runs measured a 2.3% session baseline and a 2.5% peak, since the three tasks alone never
   reach 5%. So Alpha first reads two seeded reference files of about 20k tokens each, which carries its
   session past 5% with both haikus still to write.
5. **Applied (decision 51): the repo's permissions win.** With `settingSources: ['project']`, a repo's committed
   `.claude/settings.json` loads, and its allow rules can approve a call before `canUseTool` runs (the SDK's
   `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning). The builder chose infrastructure as code: those rules are honored
   as committed, and adding a project to 10db is the trust step. 10db's `PreToolUse` guard still runs on every
   call, so claims are enforced either way. Spike 4.
6. **No change needed: a parked end isn't a failure.** Parking ends the query with
   `result.subtype: 'error_during_execution'`, and the SDK iterator throws. M1a's runner checks `st.parkedFor`
   before `event.reason` on `ended`, so such an end becomes the `parked` outcome and never spends a recovery
   attempt. Spike 6.
7. **Applied. Task 3's fake account reports `subscriptionType: 'Claude Max'`,** the real display string. The
   billing check stays "non-empty" and never compares to `'max'`. Spike 1.
8. **No change needed: "always for this project".** Neither M1 plan passes `suggestions` back as
   `updatedPermissions`. If one ever does: the SDK's `addRules` suggestion targets `localSettings`, which 10db
   never loads, so 10db stores the rule itself. Spike 5.
9. **Applied. The `STDIO_BASE_ENV` comment names `__CF_USER_TEXT_ENCODING`** as a key macOS adds under `env -i`;
   `LAUNCHER_KEY` already allowed it. Spike 4.
10. **Not applied (optional): `rate_limit_info.unifiedWindows`** reports both the `five_hour` and `seven_day`
    windows (`utilization` 0–1, `resetsAt` in seconds) in every event. It's worth recording for the frontier data
    in M2. Spike 7.

## Still unknown

- Behavior at the real context limit while compaction is blocked (spike 3).
- Whether `autoCompactEnabled: false` in `Options.settings` disables auto-compaction: the session default was
  already off, so only enabling it was shown (spike 3).
- Whether a repo's `.claude/settings.json` allow rules let repo MCP or Bash calls skip `canUseTool` (spike 4). Not
  tested, and by the builder's decision it doesn't matter: the repo's permissions win (M1b decision 51).
- The `rejected` usage-limit event as emitted live (spike 7).
- Whether the global `~/.claude.json` or the user `settings.json` supplied `autoCompactEnabled: false`. It was
  inferred to be `~/.claude.json`, because the settings file's plugins and hook never loaded (spikes 1 and 3).
- Resume after the 5-minute prompt-cache gap (spike 6's optional long-gap rerun was not run).
- `claude --bg` logs format and host permission routing (spike 10).
