# The limits judge asks a yes/no question per limit, and a second opinion settles the unclear calls

- **Date:** 2026-11-24

## Decision

10db's judge (`trust/crosses-limit.ts`) asks a call one yes/no question per limit in one request (`Judge.assess`),
over a structured state, instead of one choice among `allow`, the four limits and `unsure`. The answers are read at
the `crosses_limit` decision's floor f, never below one half:

1. The builder's lines or Retry and Send back notes allowing the call at f or more allow it.
2. Otherwise the likeliest limit at f or more is that limit.
3. Otherwise every limit under 1 − f allows the call.
4. Otherwise the call is unclear, and the `crosses_limit_second` decision's model is asked the same questions.

The second opinion defaults to `anthropic/claude-haiku-5.5` on OpenRouter and to the account's Balanced model on an
Anthropic API key or Bedrock, where the first judge is already the Efficient one. A call it leaves unclear, or that it
can't answer, skips with no limit named. A hook judge remembers each decisive verdict for the session, keyed by the
call, where it runs and the builder's lines and notes. Every call's probabilities are kept in
`judge_calls.probabilities`.

Provider classifiers are not the second judge. Codex's Auto-review sees only calls that leave the sandbox
(`decisions/2026-11-12-codex-is-judged-by-10dbs-judge.md`), and a session on 10db's judge is not in Claude's auto
mode. Both judges run on the Decisions account, so every kind of lane gets the same behaviour.

## Why

- On 2026-11-24, 188 routine calls in Ampsio's lanes were skipped: 127 `allow` answers below the floor and 61
  `unsure`. The same command flipped between the two. These skips stalled one task three times and filled the Inbox.
- The choice question had the wrong shape for a System One model. TypeSafe's guidance is to ask one narrow
  question per condition, and to give "any serious violation" a separate yes/no for each condition rather than a
  catch-all option. 10db's rule then acted on the probability of `allow` when the action that matters is the skip,
  so a call the model thought harmless but couldn't explain skipped. The prompt was also mostly unrelated paths.
- A replay of 181 real and control calls on jev-1.14, with Haiku 5.5 on the unclear ones, gave:
  - 184 of the 188 skipped routine calls run;
  - 80 of 80 calls the old judge allowed still run;
  - 25 of 25 dangerous controls still stop.

  Today's question, replayed, runs 78 of the 188. Showing the model the first lines of a script the call runs made
  no difference, so the judge reads nothing from disk.

- **Turned down:**
  - Keeping the question and adding a second opinion below the floor. That re-asks a stronger model a question the
    first had mostly answered.
  - A provider's classifier as the second judge, which doesn't exist where 10db's judge runs.
  - Lowering the floor, which would let truly unclear calls run.
