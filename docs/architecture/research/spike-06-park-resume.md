# Spike 06: A long wait ends the session cleanly and resumes it with the answer

- **Status:** VERIFIED
- **Date:** 2026-10-15
- **Versions:** claude 2.1.300 (Claude Code) · Agent SDK 0.3.299 · Node v25.2.1
- **Command:** `pnpm --dir spikes/agent-sdk spike:06`

## Question

A long wait can end the session cleanly and resume it with the answer.

## Result

Both ways of parking a session on `AskUserQuestion` worked, and so did holding the callback for the full wait.

| Variant        | First run ended                                                                                                                             | claude pid / group survivors after 3 s | Transcript on disk | Resume wrote TANGERINE | Resumed session id | Resume gap |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------ | ---------------------- | ------------------ | ---------- |
| deny-interrupt | `error_during_execution` ("Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null") | none / none                            | yes                | yes                    | same               | 3 s        |
| abort          | `error_during_execution` ("Operation aborted")                                                                                              | none / none                            | yes                | yes                    | same               | 3 s        |
| hold           | `success` after the answer                                                                                                                  | n/a                                    | n/a                | yes                    | n/a                | n/a        |

The content canary TANGERINE appeared only in the original task, so each resumed run really reloaded the
transcript. A pending `canUseTool` held for 600,001 ms (the spec's 10-minute wait) without the SDK aborting its
signal, and the answer then landed. Both park variants end the first query with an **error** result, not
`success`. The optional long-gap rerun (resume after the 5-minute prompt cache expires) was not run.

## Evidence

```
INFO deny-interrupt: first run ended: {"result":"error_during_execution","error":"Error: Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null","sessionId":"4464fa82-…","pids":[68813]}
PASS deny-interrupt: claude pid gone 3s after the query ended: {"pids":[68813],"survivors":[]}
PASS deny-interrupt: no process left in claude's group: []
PASS deny-interrupt: transcript is on disk: 4464fa82-…
INFO deny-interrupt: resumed session id: {"original":"4464fa82-…","resumed":"4464fa82-…","gapMs":3000}
PASS deny-interrupt: resumed run completed the task from the transcript: beta.txt = "TANGERINE"
INFO abort: first run ended: {"result":"error_during_execution","error":"Error: Operation aborted","sessionId":"96f683c1-…","pids":[69180]}
PASS abort: claude pid gone 3s after the query ended: {"pids":[69180],"survivors":[]}
PASS abort: no process left in claude's group: []
PASS abort: transcript is on disk: 96f683c1-…
INFO abort: resumed session id: {"original":"96f683c1-…","resumed":"96f683c1-…","gapMs":3000}
PASS abort: resumed run completed the task from the transcript: beta.txt = "TANGERINE"
INFO hold: outcome: {"heldMs":600001,"abortedDuringHold":false,"result":"success","error":"none"}
PASS hold: pending canUseTool survives 600000ms and the answer lands: held 600001ms
RESULT 06-park-resume: no failures
```

## Consequence for M1

- M1a: a short human wait keeps the `canUseTool` promise pending (confirmed up to 600,000 ms). After the
  configured wait, the adapter ends the session by deny with `interrupt: true` (abort also works) and stores
  `provider_session_id`.
- On answer, the workstream re-queues and the adapter `resume`s with the answer as the first prompt. The resumed
  session id is the same.
- The parked query ends with `result.subtype: 'error_during_execution'`, so the adapter must classify that end
  as "parked" (it initiated it), never as a session failure.
- M1a recovery need not fence orphans after a park or an abort: none survived. Its existing fencing of any live
  pid stays, as a guard for crashes.
