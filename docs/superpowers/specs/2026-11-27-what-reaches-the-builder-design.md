# What reaches the builder

**Status:** designed on 2026-11-27, not built. **Size:** a roadmap; each stage in §9 is sized by its own code.

**Builds on:** the trust decision
(`docs/architecture/decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`), the failures spec
(`2026-11-25-failures-reach-you-only-when-you-can-act-design.md`), the watchpoints spec
(`2026-11-25-watchpoints-design.md`) and pull request #953 (`2026-11-27-inbox-cards-that-mean-something-design.md`),
which decides how a card reads. This spec decides who answers each question, so that a card exists only for a
decision that is yours.

## Brief

**The answer to "what am I missing?"** Nothing. Most cards are not decisions. A card is what each part of 10db
raises when it has no rule for a refusal: asking was the cheap way to be safe, and nobody owned "who decides this?".
The gate card's three buttons show it. Start Fix Task is what a task's own gate already does without asking. Run
Gate Again is right only for a flake, which one rerun settles. Abandon is right only when you no longer want the
work, which is never the first response to a red test. On 2026-11-27 a coordinating agent answered dozens of cards
for you with a handful of rules. Those rules belong in 10db.

**What changes for you.**

- **Two promises, equally binding.** A decision only you can make always reaches you: at once, on your phone, as its
  own card, never folded, expired or answered for you. Everything else never reaches the Inbox.
- **Seven things are yours** (§1): money, one-way doors, the agent's guardrails, product and taste, promises made in
  your name, things only your hands can do, and what to do when 10db is out of moves. Every card names which.
- **Everything else has a named decider** (§3): a rule, then 10db's judge, then a stakeholder such as Mark. Each
  step up has a stated trigger. Doubt goes up, never down: an unsure judge, a kind with no rule and a judge that is
  down all escalate.
- **You audit in the header's Activity panel**, not the Inbox: what 10db decided, by which rule, with **Undo** and
  **Ask me next time** on each row.
- **A failing gate, a claim deadlock, a stuck run and an unproven criterion are worked, not asked.** You hear once,
  when the budget is spent, and the question is then the real one: spend more, change the task, or drop it.

**What it buys.** In the last 7 days 10db raised 432 cards. 220 closed themselves, 147 got an answer that changed
nothing, 29 are open, and 36 got an answer that did something (6 of those were Mark's, by Slack). Replayed under
these rights, **23 would have reached you (5%)**: about three a day, each one yours. The replay also found the
opposite error: **5 decisions that were yours were made without you** (§7), and three more reached you only through
an agent's notes.

**What could go wrong, and how we'd know.**

- _10db decides something that was yours._ Seven tests run before any automatic move (§2); any yes, or any doubt, is
  a card. Ask me next time turns a rule back into a card in one click, and Settings shows the count per rule.
- _A wrong automatic move._ Only moves that can be undone are automatic. Two undos of one rule in 30 days switch it
  to asking and tell you.
- _A fix loops or burns money._ Every automatic move draws on a budget that exists today, stops early when the same
  failure returns, and counts against a daily ceiling you set (§5).
- _Quiet drift._ Activity lists every decision; Settings › Decisions shows cards per week, undo rate and ask-me rate
  per rule.

**Calls you might disagree with** (cost if wrong).

1. **A watchpoint set to Ask is read by the judge first.** A clean read is shown in For You; a finding, a doubt or a
   destructive migration holds the pull request and cards you. You approved Ask as one card per task on
   2026-11-25. Cost: a judge misread merges an additive-looking migration you'd have questioned. If you say no, the
   replay figure is about 39, not 23.
2. **A plan whose brief needs nothing from you goes ahead after its plan review**, Core included, unless it changes a
   guardrail. Cost: a Core plan you'd have redirected is built first.
3. **Unproven criteria are sent back for proof without asking; nothing but you accepts them.** Cost: one more run
   where you'd have waved it through.
4. **A landing that brings migrations runs the project's declared migrate command on your dev database.** Cost: a
   dev database migrated at a moment you didn't choose.
5. **Nothing of yours expires or folds**, against #953 (§8). Cost: a longer Open list if the rules above are wrong.

**Needed from you:** a reply to this brief, calls 1 to 5, and the cut of §9. Nothing else.

---

## 1. What only the builder owns

| #   | Yours                    | Why it can't be delegated                                                                 | How 10db recognises it                                                                                    |
| --- | ------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | **Money**                | It is your billing line. An agent that can spend to fix its own failures has no brake.    | A credit top-up, a new paid account, or the self-healing ceiling (§5) reached.                             |
| 2   | **One-way doors**        | No undo means no audit after the fact. These are the trust decision's four hard limits.   | The limits judge (auto mode, Auto-review or 10db's); a move with no stated undo.                           |
| 3   | **The guardrails**       | The contained can't hold its own keys.                                                    | A path list: the git guard, Codex rules, sandbox profiles, judge policy, trust grants, standing approvals, `.mcp.json`, hooks, CI workflows. |
| 4   | **Product and taste**    | What the product does, how it looks, and what "done" means are why you run a factory.     | A question tagged product; a new look; accepting work that failed review or lacks proof; dropping scope.   |
| 5   | **Promises in your name** | A stakeholder or customer holds you to them.                                             | A first message to a new person or channel; a release; anything public.                                    |
| 6   | **Your hands**           | Only a person signs in, or runs what the sandbox can't.                                   | A sign-in, a credential, a host command the project hasn't declared.                                       |
| 7   | **Out of moves**         | Spend more, change the ask or drop it is money plus product.                              | A budget spent with the work still wanted.                                                                 |

Everything else is derived: a move that can be undone, inside the budget, inside the sandbox, whose answer follows
from facts 10db holds, is 10db's to make.

## 2. Who decides

Four deciders, cheapest first.

- **A rule** decides when the answer follows from facts 10db already holds (which task asked later, whether a path
  is committed, whether a pull request merged) and the move can be undone.
- **The judge** decides when someone has to read: a diff, a log, a criterion, a migration. It is the typed question
  with a confidence that exists today (`apps/daemon/src/judge`; `judge_calls` holds 11,000 calls from this week). It
  acts only at or above its floor, and only on moves that can be undone.
- **A stakeholder** answers what the product should do for its users, where the project routes questions to a
  person (`apps/daemon/src/stakeholders`, the judge's `question_route`).
- **The builder** owns §1.

**The ownership test.** Before any rule or judge acts, and before any card is filed for someone else, 10db asks the
seven questions of §1 about the move. Tests 1, 3, 6 and 7 are code: a counter, a path list, a known cause, a
budget. Tests 2, 4 and 5 are the judge's. Any yes makes it the builder's, whatever the row in §3 says.

**Doubt goes up.** These are the guards against under-escalation:

- A judge answer below the floor (`below_floor`), a fallback (timeout, error, outage) or a refusal never acts. It
  goes to the next decider. A judge that is down makes every judge row a builder row for as long as it is down.
- A card kind with no row in §3 is the builder's. A repo test fails for a card builder that declares no decider.
- A deterministic yes can't be overruled by the judge: a guardrail path is the builder's even if the diff reads as
  harmless.
- Any agent can say "this is the builder's" (`ask_human`, a proposal), and that claim is honoured unless a rule in
  §3 names the case.
- An agent never decides about its own work. The judge and the reviewer are not the lane that wrote the change.
- **Ask me next time** on an Activity row turns that rule into a card for that project. It is the complement of
  Undo, and it is how a missing "yours" gets found.

**A builder card's guarantees.** It is raised at once and pushed to the phone and the Mac, whatever its urgency
field says (225 of this week's 432 cards were marked high, so the field has stopped meaning anything). It is one
row, never folded with others. It never expires, and 10db never answers it; it is pushed again once after 24 hours.
It names which of the seven it is and what is stopped. Work that doesn't depend on it carries on.

## 3. The decision-rights table

Counts are cards in the 7 days to 2026-11-27 19:40Z. "Undo" is whether the automatic move can be taken back.

| Situation (cards)                         | Decider                | What 10db does                                                                                                           | Escalates when                                                                                             | What you see then                                                         | Undo                    |
| ----------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------- |
| Write outside every claim (113)           | Rule                   | Nothing: the path is committed, or the lane takes a claim over it. A notice.                                             | The path is a guardrail (yours, 3).                                                                        | "A lane edited your git guard": the diff, Keep or Revert                  | Yes (git)               |
| Merged hand-made worktree (48)            | Rule                   | Removes it when merged, clean, idle 24 h and no process is in it. The branch stays.                                      | Never. A file found nowhere else is saved under `~/.10db/kept/` first.                                     | Nothing                                                                   | Yes (branch, kept copy) |
| Watchpoint hit (32)                       | Judge                  | Reads the hunks against your guidance. Clean: For You and a notice. Raised once, for the task's own changes.              | A finding, a doubt, a destructive migration (drop, rename, narrow, backfill), or loudness Hold.            | The card before merge, with the pull request held                         | Not merged yet          |
| Failed run (32)                           | Rule, then judge       | The failures spec's triage: retry a crash, wait on a standing approval, file a 10db defect, close a moot one.             | Budgets spent and the task still wanted (7); the cause needs your hands (6).                               | "Out of moves": spend N more attempts, change the task, or drop it        | Yes (a retry)           |
| Stuck run (30)                            | Rule                   | Restarts once from the latest handoff. All 30 this week moved again by themselves.                                       | The restarted run stalls too, and the diagnosis names no 10db defect.                                      | Out of moves                                                              | Yes                     |
| Calls skipped while away (30)             | Rule                   | The task finished without them: a notice. A kind the judge keeps doubting joins the standing-approval card.              | The skipped call was the whole job, or it left config waiting on approval (2, 3).                          | The skip, in words, with Run It                                           | Nothing ran             |
| Claim deadlock (30)                       | Rule                   | After 2 minutes the later asker yields, handing over committed work only. A repeat queues the yielder behind the other.  | Never. A third repeat files a 10db defect.                                                                 | Nothing                                                                   | Yes (it asks again)     |
| Pull request checks, CI, red base (25)    | Rule                   | Rerun once, then a Fix CI batch; a red base waits (all built).                                                           | The Fix CI cap is reached and the pull request is still open 30 minutes later.                             | Out of moves                                                              | Yes                     |
| Judge can't answer (18)                   | Rule                   | A header status line; fails over to another account of yours that runs decisions.                                        | No credits, 401, 403 or an expired sign-in, and no other account (1, 6). Raised at once.                   | "The judge needs credits on OpenRouter", and what is skipped meanwhile    | n/a                     |
| Criteria not proven (9)                   | Rule                   | Sends the task back for proof, inside its fix budget. Never accepts.                                                     | Proof needs the host (6), or the budget is spent (4, 7).                                                   | "Accept without proof of X, or drop it"                                   | Yes (a run)             |
| Linear or picture sign-in (12)            | Rule                   | Retries at its backoff and closes when signed in (built).                                                                | The cause is a missing sign-in, after one failed retry (6).                                                | One card: Connect Linear                                                  | n/a                     |
| Agent's question (9)                      | Judge routes           | Product questions go to the project's stakeholder by Slack (6 of 9 this week).                                           | No stakeholder, no reply in 24 h, the reply says to ask you, or the question touches 1, 2, 3 or 5.         | The question, with Mark's thread if there is one                          | n/a                     |
| Gate held by the dev stack (7)            | Rule                   | Waits; all 7 cleared by themselves.                                                                                      | Still held after 30 minutes (6).                                                                           | The command to run                                                        | n/a                     |
| Agent's proposal (7)                      | Rule, then judge       | "Review my plan": Core work gets its plan review as a step. A prerequisite inside the goal is filed, once.                | New scope outside the goal, a dropped criterion, or work on a data-loss surface (4).                       | The proposal, with what it adds and costs                                 | Yes (a filed task)      |
| Ship gate failed (6)                      | Rule                   | Reruns once when the failure is outside the batch; otherwise files a fix task in the batch.                              | Fix attempts spent, or the same failure returns after a fix.                                               | Out of moves, with the summary #953 designs                               | Yes                     |
| Self-update failed (5)                    | Rule                   | The next merge's update replaces it (built).                                                                                           | Three commits in a row fail.                                                                               | One card with the build error                                             | Yes                     |
| Repo MCP server (4)                       | Builder                | Nothing; sessions run without it.                                                                                        | Always (3).                                                                                                | One card per server, as today                                             | Yes (Settings › Trust)  |
| Migrations landed (3)                     | Rule                   | Runs the project's declared migrate command on the dev database.                                                         | No command is declared (6, asked once), or it fails.                                                       | "Tell 10db how ampsio migrates"                                           | No, so dev only         |
| Plan ready (2)                            | Plan review            | Goes ahead when the brief needs nothing and the reviewer finds no undeclared call from §1.                               | The brief names a call from §1; the plan changes a guardrail.                                              | The brief                                                                 | Yes, until built        |
| Standing approval offered (1)             | Builder                | Offers it once the judge has doubted a kind three times.                                                                 | Always (3).                                                                                                | One card per project, as built                                            | Yes (Settings)          |
| Kept worktree, flaky check, commit not recorded, start refused, copy waiting (8) | Rule | Saves and removes; files a fix task on the second flake; retries the commit; starts when the dependency merges.   | The retry fails twice.                                                                                     | Out of moves                                                              | Yes                     |
| Account moved to the fallback (1)         | Rule                   | Moves and moves back (built); a notice.                                                                                  | The ceiling (§5) is reached on the fallback (1).                                                           | "Bedrock has spent $N today: carry on or wait for the plan"               | Yes                     |
| A change to a guardrail (no card today)   | Builder                | Opens the pull request without auto-merge.                                                                               | Always (3).                                                                                                | "A change to your git guard is ready": the diff, Merge or Close           | Not merged yet          |
| Shipping work that failed review (1 above) | Builder                | Reviews it again when a later task in the batch fixed the finding.                                                       | Always, if it is still rejected (4).                                                                       | "Ship with this finding open, or without the task"                        | No                      |

## 4. What exists already

- **Budgets:** fix attempts and review rounds per rigor (`routing/playbook-defaults.ts`, `maxFixAttempts`), four
  recovery attempts, the Fix CI cap (`delivery/ci-stop.ts`), one rerun of a failed check (`delivery/ci-rerun.ts`),
  three conflicts before a standing approval pauses (`PRECEDENT_CONFLICTS_MAX`).
- **Classifiers:** `delivery/ci-failure-class.ts` (ours, the base's or flaky), `gateFailedUnrelated` and
  `outsideTheBatch` at ship, `stalls/rules.ts`, `yieldRefusal` in the claims.
- **Closers:** `resolveStaleCards` and the event closers; 220 cards closed that way this week.
- **Notices and the Activity panel:** `postNotice`, `GET /activity/page`, `views/factory/activity-drawer.tsx`.
- **The judge:** typed questions, a confidence floor, a shadow mode and a call log. New here are four questions:
  is this migration destructive, does this hunk meet the watchpoint's guidance, is this proposal inside the goal,
  and tests 2, 4 and 5 of the ownership test.
- **Stakeholders:** routing, Slack sends, reminders and the reply reader.

What is new is small: a decider declared on every card builder, the ownership test, the out-of-moves card, Undo and
Ask me next time on Activity rows, and the ceiling.

## 5. How self-healing fails, and its guards

- **Loops.** Every automatic move spends from one of the budgets in §4; none has a budget of its own. A failure is
  given a signature (the step, the failing tests, the error's first line). The same signature after a fix stops the
  work at once instead of spending the rest. Follow-ups of follow-ups stop at depth two, as #953 has it. A rule that
  fires three times on one task files a 10db defect.
- **Budget burn.** One ceiling per project per day for work 10db started by itself (fix tasks, restarts, retries,
  diagnoses), set in Settings with a default. Reaching it stops new automatic work and raises one card (yours, 1).
  Work you started is never counted.
- **Wrong automatic decisions.** Only moves with an undo are automatic, and the row in Activity carries the Undo
  for as long as it holds. Two undos of one rule in 30 days switch that rule to asking for that project and say so
  in one card. A new judge question runs in shadow for a week against what was actually answered before it acts.
- **Silent drift.** Settings › Decisions gains one table: per rule, the decisions made, undone and sent up in the
  last 30 days. A rule that decides more each week while its undo count is zero is the one to sample; the table
  sorts by that.
- **Under-escalation.** §2's guards, plus the app recording who answered each card (`answer.answeredBy` exists
  only for Slack today), so an agent answering for you is visible and countable.

## 6. Auditing what 10db decided

The header's Activity panel is the audit. The Inbox holds only what needs you and gains no tab.

- Each row reads: what happened, what 10db did, who decided (the rule's name, or "the judge, 91% sure"), and Undo
  or "can't be undone now".
- A filter, **Decided for you**, leaves out plain notices. Rows group by rule with a count.
- **Ask me next time** sits beside Undo.
- The header's icon shows a dot only when a rule was switched to asking or the ceiling was reached. Ordinary
  decisions never badge or notify.

## 7. The 7-day replay

432 cards, created 2026-11-20 19:30Z to 2026-11-27 19:40Z, read from the live database.

**Today.** 220 closed themselves. 183 were answered: 147 with a choice that changed nothing (58 stray writes, 26
skips, 23 worktrees, 16 Looks Right, 14 failed runs, 4 acceptance Accepts and 6 others), 36 with one that did. 29
are open. At least 101 answers carry a note showing an agent gave them.

**Error 1: cards that needn't have reached you.** Under §3, 23 of 432 reach the builder, so 409 (95%) didn't need
to.

| Reaches you                                                                                          | Cards |
| ---------------------------------------------------------------------------------------------------- | ----- |
| Failed runs: three out of moves, two needing your hands, one shipping rejected work                   | 6     |
| Repo MCP servers                                                                                     | 4     |
| Questions with no stakeholder route                                                                  | 3     |
| Criteria whose proof needs the host, or whose budget is spent                                        | 3     |
| Skips that were the job (Run These Now was chosen)                                                   | 2     |
| Judge credits, a standing approval, the Linear sign-in, the migrate command, a proposal: one each    | 5     |
| Watchpoints: every one read was additive or a repeat                                                 | 0     |

The watchpoint figure rests on 16 answered cards, 8 of them repeats for another task's migration; the 16 open ones
are unread. Failed runs are a reading of 32 bodies. Treat 23 as "20 to 30".

**Error 2: decisions that were yours and were made without you.** 10db made none that I can find; its closest is
the move to Bedrock, which you configured but which has no ceiling. The coordinator made five:

1. **Ship Anyway** on work the review rejected twice (Partner uploads, 2026-11-26). The finding had been fixed by
   another task, so a second review would have settled it without anyone overriding.
2. **Accept** on criteria with no proof, twice (the wall manager browser test, "CI is the gate"; the company
   workbook card, with no note). Yours, 4.
3. **#932 merged without your screenshot approval** (the hand-off's rulings). Yours, 4.
4. **Three proposals accepted** that add a Core, destructive recovery task to Ampsio. Yours, 4.
5. **Two Core plans approved** "by the builder's coordinator" (2026-11-26). Under call 2 these go ahead, but
   nothing told you.

**Reached you, by the wrong road.** The git guard change (3; the classifier rightly refused the agent, and the work
sat uncommitted in a worktree), `make db-prepare` (6) and the 18 cards the classifier wouldn't let an agent answer
in bulk lived in an agent's notes. Only the OpenRouter credits had a card.

## 8. Where this departs from #953

Its card grammar, titles, log summaries, rule-written recommendations and the Activity panel stand. The departures:

1. **No expiry and no fold.** #953 lets Look and acceptance cards leave Open after 7 days as "kept as is" and folds
   them into a row with Mark All Looked At. That answers a builder decision by default, and a bulk button concedes
   the cards aren't decisions. Decide the owner earlier: if it is yours it holds the merge and waits; if not it
   was never a card.
2. **Keep As Is is never recommended by a rule.** Accepting unproven work lowers your bar.
3. **Push for every builder card**, not only high ones.
4. **More kinds leave the Inbox**: stray writes, skips, failed runs short of out-of-moves, start refused and
   migrations landed all "stay" in #953.
5. **The gate card isn't three peer buttons.** It appears when the fix budget is spent and asks one question.
6. **A repeated claim deadlock is queued, not carded.**
7. **Its stage D is cut; its F stages are kept** and listed below.

## 9. Stages

| Stage | Size    | What                                                                                                                              |
| ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Small   | Stray writes off guardrail paths, flaky checks and transient judge outages become notices; a failed-run card closes when its pull request merged or its batch is gone |
| 2     | Small   | The app records who answered a card                                                                                               |
| 3     | Feature | Every card builder declares its decider and, for a builder card, which of the seven; the repo test; Open holds only builder cards, pushed, never folded; Activity rows gain the decider, Undo and Ask me next time |
| 4     | Core    | Ship gate: rerun once or fix task (#953 F1), the failure signature, the out-of-moves card for gate, failed run and CI             |
| 5     | Core    | Claim deadlock: yield, committed work only, then queue (#953 F2)                                                                  |
| 6     | Core    | Stuck run restarted once (#953 F4); worktree leftovers saved and removed (#953 F3)                                                |
| 7     | Feature | Criteria: sent back for proof by rule; the your-hands card; a second review before Ship Anyway is offered                         |
| 8     | Core    | Guardrail paths: the path list, the held pull request and its card; the ownership test's three judge questions, in shadow first   |
| 9     | Core    | Watchpoint Ask read by the judge, with the hold (watchpoints S5); needs call 1                                                    |
| 10    | Feature | Proposals routed; Core work gets its plan review as a step; the declared migrate command runs after a landing                     |
| 11    | Core    | The daily ceiling; a rule switched to asking after two undos; the Decisions table                                                 |
| 12    | Feature | The judge on a plan-only account (§10)                                                                                            |

Order: 1 to 3 now; then 4, 5 and 7, which remove the most; then 8 before 9 to 11. Each Core stage gets its own index
and cards. Tests follow `.claude/rules/testing.md`: the path list, the signature and the ownership test are pure
rule tables; the rest extend the `loop` and `inbox` e2e flows.

## 10. Per provider

- **Rules, budgets, notices, the Activity panel and builder cards** are 10db's own and the same on a Claude plan,
  Claude through Bedrock or an API key, and a ChatGPT/Codex plan.
- **Fix tasks, restarts and reviews** run on the project's own account, as every lane does.
- **Limits inside a session** are judged as today: Claude's auto mode, Codex's Auto-review, or 10db's judge.
- **The judge rows** need an account decisions run on: OpenRouter, an Anthropic API key or Bedrock. A plan login
  can't run them (`PLAN_LOGIN_CANT_DECIDE`). With only a Claude plan or only a ChatGPT plan, every judge row falls
  to its rule where one alone is sure and otherwise to the builder, and the card says a Decisions account would
  have settled it. Stage 12 closes the gap by asking the same typed question in a short session on the project's
  own account, Claude or Codex.
- **The ceiling** counts dollars on Bedrock and API keys, and the share of the plan's limit on a Claude or ChatGPT
  plan.
- **Stakeholder routing** is Slack and the same everywhere.

## 11. How we'd know it worked

Three numbers, weekly, from `inbox_items` and the Activity events: builder cards raised (aim: under 30, from 432);
the share answered with a choice that changes nothing (aim: under a fifth, from 80% of answers); and decisions found
by Ask me next time or by an agent's note (aim: zero, from 5).

## 12. Sources

The live database (`inbox_items`, `judge_calls`), read-only, 2026-11-27 19:40Z; the coordinator's ledger and hand-off
of 2026-11-27; the daemon modules named in §4.
