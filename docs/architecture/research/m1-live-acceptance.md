# M1 live acceptance (§1.3 on a disposable repo)

- **Status:** VERIFIED
- **Date:** 2026-10-17
- **Model:** sonnet @ medium
- **Claude Code:** 2.1.302
- **Node:** v26.12.0
- **Handoff threshold:** 5% (nudge 6%)
- **Repo MCP server:** mantine (-y @mantine/mcp-server@9.7.2, from the repo's .mcp.json, approved through its card)
- **Session baseline context:** 2.3–7.1% (first reading of 6 session(s))
- **Work dir:** /var/folders/m6/z7h016t90h58n7qkvfg_s8hh0000gn/T/10db-live-9X5D1f
- **Command:** `pnpm live-acceptance`

## Checks

| Check                      | Result | Detail                                                                                           |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| tasks done                 | PASS   | 3 of 3 workstreams DONE (need 3)                                                                 |
| gate evidence              | PASS   | 0 DONE workstream(s) without a passing gate record                                               |
| handoff crossed            | PASS   | 2 handoff(s)                                                                                     |
| question answered          | PASS   | 1 question card(s) resolved                                                                      |
| recovered after kill -9    | PASS   | 2 recovery.step event(s)                                                                         |
| no duplicate commits       | PASS   | 4 op trailer(s), all unique (need at least 3)                                                    |
| no duplicate tool ops      | PASS   | 0 duplicated (workstream, opId) pair(s)                                                          |
| events replay without gaps | PASS   | 130 event(s), max seq 130                                                                        |
| subscription billing       | PASS   | 6 of 6 billing line(s) first-party for 6 started session(s); 0 billing failure(s)                |
| repo MCP server approved   | PASS   | mantine passed, with env HOME and PATH only, at 6 of 6 session start(s) for 6 started session(s) |
| repo MCP server connected  | PASS   | mantine status after the first turn in 4 of 4 session(s): connected                              |
| repo MCP tool gated        | PASS   | 1 permission card(s) for mcp__mantine__ tools: repo tool calls reach canUseTool                  |
| repo MCP server env        | PASS   | mantine ran with 28 key(s): PATH, HOME and npm's own                                             |
| window close and reopen    | PASS   | nothing lost (checked by the builder)                                                            |

The `task outputs` check was added after this run, once the gate stopped checking each task's file; run
against this run's repo, it passes: `src/alpha/one.md`, `src/alpha/two.md`, `src/beta/greeting.md` and
`src/gamma/notes.md` are committed and non-empty at HEAD.

## Consequence

M1 passes §1.3 on a disposable repo. Next: the same run on the pilot project (M3).

## Earlier runs

Three runs failed before this one:

1. The mantine server failed to connect in every session. The builder's npx cache entry for
   `@mantine/mcp-server@9.7.2` had no `package.json`, so `npx -y` exited 254 with or without 10db's
   `env -i PATH HOME` launch; clearing that cache entry fixed it. The same run's gate fixture required every
   task's folder to hold a `.md`, so Alpha and Gamma failed their gates while Beta was parked on its question.
   The fixture now checks only that no `.md` is empty.
2. Everything passed except `handoff crossed`: sessions start at 2.3% of the 1M window and the three tasks
   peaked at 2.5%, under `handoffPct` 5. Alpha now reads two seeded reference files of about 20k tokens each
   before writing.
3. Alpha crossed 5% and went to HANDING_OFF, then the kill -9 landed before its handoff. Recovery resumed the
   same conversation at 7.1%, and the runner gave it the continuation margin (first reading + 5 = 12.1%), so
   the handoff was dropped. The margin now applies only to a fresh session that starts from a briefing; a
   resumed session hands off at `handoffPct`. This run went through that path: Alpha's resumed session handed
   off at 7.1%.
