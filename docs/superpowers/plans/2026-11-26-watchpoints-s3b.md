# Watchpoints S3b: a judge question, in Shadow

**Size: Feature.** One implementer builds it end to end, then one review that blocks only on bugs. The spec is
`docs/superpowers/specs/2026-11-25-watchpoints-design.md` (§ A watchpoint `question`, § The library, § Provider
parity). S3a (line patterns, #897) and the Settings rework (#927) are on main.

## Brief

**What changes for you.**
- A watchpoint can have a **question**: a yes/no that 10db's judge asks of the changes its paths and lines cover
  but don't settle. An example is "Does this change who can do what: sign-in, sessions, tokens, roles or permission
  checks?"
- The question ships **in Shadow**. When you switch the new decision on (Settings › Decisions › Watchpoint
  question, off by default), the judge answers after each passing gate. The answer goes to the
  call log (Settings › Decisions › Recent) and is kept on the task's reading; nothing is shown on the task, and it
  never raises a card, forces a review, or holds anything yet.
- A replay script asks the question over past finished runs, so its answers can be checked against what you
  would have flagged before it acts. Switching it to act is a later, small change, made once the replay agrees.
- The library gains **Design principles** (UI files, with a question about how the interface looks or behaves) and
  **Auth and permissions** (any file, with a question about who can do what). Both are show, in the library only.

**What it buys.** It catches changes that no path or pattern names, such as a permission check moved inside
ordinary code. It is measured before it is trusted.

**What could go wrong, and how we'd know.**
- *Cost.* One call per run per watchpoint whose question has unsettled files, and only while the decision is
  on. Settings › Decisions shows its calls and cost, as for every decision.
- *A wrong answer.* It is shadow only, so it changes nothing. The replay and the Decisions tab show agreement.
- *No Decisions account.* The question isn't asked. The drawer says "Judge questions aren't checked: no account
  can answer decisions."

**Calls you might disagree with.**
- One question per watchpoint per run, over all its unsettled files, not one per file. That is cheaper, and the
  answer names the watchpoint, not the file.
- A line match settles a file without asking. The judge is asked only about files the rules left open.

**Needed from you:** nothing. Turning the decision on, and later letting it act, are yours to do when you want.

## Provider parity

| | Claude plan | Bedrock or API key | ChatGPT/Codex plan |
| - | - | - | - |
| Asking the question | Only on a Decisions account (OpenRouter, Anthropic API key, Bedrock). With none, it isn't asked, and the drawer says so. | Asked on the Decisions account | As on a Claude plan |
| Everything else | Same | Same | Same: the daemon does it |

## Parts

1. **Contracts:**
   - `Watchpoint.question: z.string().trim().max(400).nullable().default(null)`. `sameWatchpoint` compares it, and the
     revision literals get `question: null`.
   - `JudgeDecision.WatchpointQuestion = 'watchpoint_question'` goes in `JudgeConfig.decisions`, off by default
     (Acceptance's pattern).
   - `WatchpointDetail` gains an optional `shadow: Array<{ key; label; asked: string[]; yes: number | null }>`. It is
     backward compatible: an old row reads as none, and the `.catch` fallback is unchanged.
   - Starters (library only, show):
     - **Design principles**: UI globs (`**/*.{tsx,jsx,vue,svelte}`, `**/*.{css,scss}`, `**/components/**`), with the
       question "Does this change how the interface looks or behaves for the user: layout, wording, colours, controls
       or flows?"
     - **Auth and permissions**: `**`, with the question "Does this change who can do what: sign-in, sessions,
       tokens, roles, or permission checks?"
2. **Daemon matching** (`apps/daemon/src/watchpoints/`):
   - A watchpoint with a question is a hit only through its globs plus lines (as now). Without lines, a question
     watchpoint makes **no** rule hit. Its glob-covered files that no line settled are its question candidates
     (`questionCandidates`, pure, beside `lineCandidates`).
   - A new `question.ts` asks it, after the reading and outside the write, as `acceptanceAfter` does:
     - one `judge.assess` with one `NoulQuestion` per watchpoint;
     - the candidates' hunks fenced as data, capped like `ACCEPTANCE_DIFF_CAP`;
     - a 20 s timeout;
     - each call's outcome recorded as `JudgeOutcome.Shadow`.
     It never throws: no answer leaves `yes: null`. The runner stores the result as `shadow` on the reading.
   - It isn't asked when `judge.ready(WatchpointQuestion)` is false, or there are no candidates.
3. **Desktop:**
   - The drawer gets a **Question** field (optional, one line, max 400) with the note above when no Decisions account
     is set.
   - Settings › Decisions gets the decision in `decision-catalogue.ts` and its other per-decision tables, which are
     exhaustive.
4. **The replay script** `apps/daemon/scripts/watchpoint-question-replay.ts`, modelled on `acceptance-replay.ts`:
   - It reads a copy of the database and the repo, takes finished runs, and asks each question watchpoint (from the
     builder's list, or `--starter design-principles|auth-and-permissions`) over the run's diff.
   - It writes JSON lines with the hunks and the answer, for hand labelling, plus a summary.
   - Without a credential it counts the sample and calls nothing.
5. **Docs:** the watchpoints `AGENTS.md` note, the judge `AGENTS.md` decision list, and the spec's scope row (S3b
   built, in Shadow).

## Tests

- **Extend the rule table** in `match.test.ts`:
  - a question watchpoint with no lines makes no rule hit, and its covered files are candidates;
  - a line match settles a file, so it isn't a candidate.
  Prove them red first.
- No test of the judge call (it is model behaviour; the replay measures it) and no new e2e.

## Done

- Typecheck, lint, and the related tests pass. Run the watchpoints, runner and judge test files, the delivery-config
  ship and pr-text tests, and `make precheck`.
- Then the lead runs one review and a PR with auto-merge.
