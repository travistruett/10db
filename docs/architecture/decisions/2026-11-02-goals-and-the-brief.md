# A goal is an outcome 10db pursues across tasks; its brief is imported, and the engine classes one-way decisions

- **Date:** 2026-11-02
- **Amends:** the goals design (`docs/superpowers/specs/2026-10-29-10db-goals-design.md`), whose §14 records the builder's answers of 2026-10-30; `decisions/2026-11-01-adopt-a-goal-from-a-brief.md` carries the adopt route's details

## Decision

**A goal.** A goal is an outcome with acceptance criteria that 10db pursues across many tasks. It has a title, an
objective, criteria, an owner (a person, the builder by default), tasks and, from phase 2, a state and a budget.
A task belongs to at most one goal. The builder manages goals, not tasks: Factory shows goals, the Board shows
tasks (a goal is a slim strip above the columns, never a card), and the Inbox shows what needs a person.

**Phase 1 stores no goal state beyond `draft`.** A goal's status is derived from existing rows (the digest,
`goal-digest.ts`), in the order failed, waiting on you, running, shipping, not started, done, with the colors
in `DESIGN.md` (red, yellow, blue, blue, gray, green). Done in phase 1 means every task not cancelled is done
and its pull request merged; Shipping keeps the goal blue until then. From phase 2, done is every criterion proven.

**The brief format.** A brief is a Markdown file with YAML front matter: `title`, `objective`, `cares_most`,
`criteria` (text and check kind: `task`, `merged`, `command`, `accept`), `budget`, `tasks` (a key, title,
description, `criteria`, `areas`, `depends_on`) and optional `people` (proposals the owner confirms). The text
below the front matter is the goal's notes. The `GoalBrief` schema in `@10db/contracts` checks the shape;
`apps/daemon/src/goals/brief.ts` checks the rules that need the project (unique keys, every reference naming a
key, no dependency cycle, every area existing), and answers every error at once.

**The brief is import only (the builder, 2026-10-30).** Nothing is written into the repository. 10db keeps
the brief as the rows it produced, with no second copy of the file text.

**The builder's other answers of 2026-10-30.**

- **Starting a goal's task by hand (spec §4) is confirmed.** A goal's task can be started from its card and runs
  as it would alone, with the existing dependency refusal (a task whose dependency isn't done is refused as it
  is today). Starting one does not change the goal.
- **Leftover tasks (spec §5) stay on the Board when a goal is done.** The done card offers to remove the
  unstarted ones as well as to cancel the running ones. Nothing is removed or cancelled unless the builder
  chooses it.

**The engine, not the agent, classes one-way decisions (phase 2).** Which calls are one-way is decided by fixed,
testable classes the daemon applies (schema, contracts, deletes, spend, ship, outside people, membership) plus a
dependency count: when the tasks that depend on a two-way decision, started after it, reach N (default 3), the
decision needs the owner. An agent records its decision with `record_decision`; at the end of each step the
daemon compares the diff with the one-way path classes and raises a card itself for a one-way change with no
matching recorded decision. An agent never sets its own `door`.

## Why

- A goal gives the builder one thing to follow where they followed fifteen sessions; the builder is the glue
  today, and Factory's per-workstream table answered none of their questions.
- Deriving status in phase 1 adds no schema or state machine before the engine exists, and lets the rule be
  checked against rows. Green only after merge keeps the "done" color honest: a goal with open pull requests
  isn't finished.
- A brief kept only as rows has no second copy that edits to the goal would let drift. A raw-text column is a
  forward migration if the builder wants the original back. Keeping briefs in the repository was offered and
  declined.
- Hand-starting stays possible because the builder often just wants to see one task run. The dependency refusal
  is the safety that exists already. Leftover tasks may be wanted later, so finishing a goal never deletes
  work unasked.
- **Why the engine and not the agent.** An agent the builder rates 50/50 on judgment shouldn't classify its own
  doors: a model that is wrong about a decision's reversibility is often wrong in the same direction about
  recording it. Path classes and a count are deterministic and testable, can't be talked out of by the task,
  and catch an unreported structural change from the diff alone. An LLM is used only where judgment is needed,
  and its output is a proposal the engine validates.
- Alternatives turned down: a field on `record_decision` the agent fills in (self-classification); a model
  that grades each decision (not testable, costs a call per decision); a goal state machine in phase 1 (no
  checks to run until phase 2).
