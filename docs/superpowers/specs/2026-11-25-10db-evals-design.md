# Evals: find, view and define a project's evals

**Size.** Slices 1–4 are Feature. Slice 5, running a live eval from 10db, is Core (secrets, data sent out,
spend) and gets its own plan once the builder makes its product call.

## Brief

**What changes for you.** A project gets an **Evals** page, after Knowledge in the sidebar. It lists each eval suite
10db finds in the repository at HEAD, with:
- its bar in the repo's own words;
- the last result per model: gates passed, and the gate furthest under its minimum when one fails;
- the last eight runs as dots;
- the cost of a run and its p50 latency.

A suite's drawer shows each gate's rate against its minimum, every committed run, the flaky cases, what code the
suite covers, and its free and live commands. A **No Eval** tab lists the LLM work no suite covers. ampsio's 123
committed reports fill the page the first time you open it, and nothing runs a model.

Later slices add the rest:
- A task whose diff touches a suite's code gets a marker on its card, and its drawer shows before and after (slice 2).
- **New Eval** files a task that drafts an eval in the project's own format (slice 3).
- A change to an eval's definition goes to your judgment through Focuses (slice 4).

**What it buys.** You can see your eval results across runs and models in one place, plus the eval backlog. Until
now they were 123 JSON files in ampsio, and nothing at all for orgtools' pytest evals.

**What could go wrong, and how we'd know.**
- *File names miss or misname a suite.* File names only find suites and result files. An agent's assessment links
  each definition to its suite and adds the bar, covered code, commands and gaps. 10db refuses a manifest that
  names a path the repo doesn't track, or a glob that matches nothing. Until the assessment runs, the page says
  "Found by file names" and lists the eval files it couldn't link.
- *Cost reads as free.* A report with no cost shows "unknown", never $0.
- *A result file 10db can't read.* It is skipped, not fatal. The suite then shows fewer runs than the folder holds,
  and the debug log names the file.

**Calls you might disagree with.**
1. **10db defines no eval format.** It reads yours: ampsio's gate reports and 10db's own lane-pipeline baselines
   first. It owns only a manifest (a project setting, not a repo file) and a normalized result.
2. **The assessment runs in your own session, not as a new 10db flow.** The daemon finds suites by file markers
   for free on every provider. The manifest is filled by a new "Assess a project's evals" step in the `10db-task`
   skill, the same way hazards are assessed: the page's **Copy the Ask** gives you the sentence to paste into any
   Claude Code or Codex session. *Cost if wrong:* there's no one-click "Read" button inside 10db. Building one
   later reuses the same manifest and route.
3. **Matching a task to suites is by path, not by a judge** (slice 2), so it works on a plan login.
4. **A product eval's model calls stay on the project's own key** (OpenRouter in ampsio, Bedrock in orgtools),
   never on 10db's account. 10db never runs the live arm before slice 5.
5. **`claude plugin eval` suites are found but their results aren't read yet.** Their result file is documented
   only down to its top-level keys, and no real result exists on this Mac to build from. Running one to get a
   sample spends money. The suite lists with "No run could be read" until a real file exists.

**What's needed from you.** Approval of the look, from screenshots of the running app. One product call before
slice 5: may a spend limit let 10db run live evals unattended, or is every live run a click? I'll ask it separately.

---

## What the builder's projects have

Research: `~/Agents/notes/10db/2026-11-25-evals-research.md`.

- **ampsio:** each registered LLM task names its eval file (`eval = "evals/<area>/<task>.py"`) and its bar in
  words (`bar = "..."`). All 20 tasks have one. Live runs write `evals/reports/<task>/<UTC ts>.json`: 123 reports
  across 13 tasks, versions 1–9, with gates per model slot, billed cost, latency and per-case assertions. 8 suites
  have never been run live. An eval file doesn't name its task, so only the task class links file to suite.
- **orgtools:** 59 pytest eval modules under `apps/*/tests/eval/`. No result files: results live only in pytest's
  output. A registry (`workflow_specs.py`) names each workflow's eval, and `enforced_by=None` marks one with a bar
  but no eval.
- **10db:** the lane-pipeline eval saves `apps/daemon/evals/lane-pipeline/baselines/<rigor>.json`. None is
  committed yet.

## Slice 1: the read-only Evals view (built here)

### Discovery (daemon, `apps/daemon/src/evals/`)

10db reads the repository at HEAD through `Git.survey` and `Git.surveyTexts`: the object store only, never the
working tree, no program the repo configures, and never a model. A pure rule table turns tracked paths into
suites:

| Marker | Gives |
| --- | --- |
| `evals/reports/<task>/<ts>Z.json` | gate-report results; the suite key is the report's `task` |
| `evals/lane-pipeline/baselines/<rigor>.json` | lane-pipeline results; key `lane-pipeline:<rigor>` |
| `evals/<area>/<name>.py`, `tests/eval/test_*_eval.py` | eval definitions, listed as unlinked until a manifest links them |
| `evals/<case>/prompt.md` | a `claude plugin eval` suite; results not read |

Each format's adapter validates only the fields it reads (zod, loose) and maps them onto `EvalRunSummaryDto` and
`EvalModelResultDto` (`packages/contracts/src/evals.ts`). Parsed results are cached per project and HEAD commit.

### The manifest

`EvalManifest` is stored in `app_settings` under `evals-manifest:<projectId>`, beside the hazard assessment, so
no migration is needed. It lists:
- per suite: label, bar, definition paths, covered globs, free command and live command;
- the gaps: LLM work with no eval, where it is, and why it counts.

`PUT /projects/:id/evals/manifest` keeps a manifest only when every definition path is tracked and every covered
glob matches at least one tracked file. Otherwise it refuses and names the untracked paths, and it records the
commit it read. A recorded manifest emits the `project` event.

The `10db-task` skill's "Assess a project's evals" gathers the evidence from the repo:
- its LLM-task registry and eval bindings;
- the bar as the repo words it;
- the commands from its AGENTS.md and Makefile;
- the code each suite covers;
- the LLM work with no eval.

It writes the manifest JSON and applies it through `evals <projectId> <file>`. It never runs a live eval.

### Routes

- `GET /projects/:id/evals` → `EvalsDto`: suites (failing first), unlinked eval files, gaps (null before an
  assessment), the commit read, and `assessedAt`.
- `GET /projects/:id/evals/:suiteKey?run=<path>` → `EvalSuiteDetailDto`: the suite, every run (newest first), one
  run whole (the newest by default), flaky cases across the last eight runs, and the manifest's covered paths and
  commands.
- `PUT /projects/:id/evals/manifest` → `EvalManifestResult`.

### The view (`apps/desktop/src/views/evals/`)

The view follows DESIGN.md:
- Page width, with the title row "Evals · <project>".
- One dim summary line: suites, passing, failing, with no results, the commit read, and that nothing ran a model.
- Underlined tabs: Suites and No Eval.
- The suites table is one raised panel. A status is text and a dot, never a pill.
- A suite opens in a `SurfaceDrawer`.

Before an assessment, a bordered line offers Copy the Ask. Notes: `views/evals/AGENTS.md`.

### Provider parity

| | Claude plan | Bedrock / API key | ChatGPT / Codex plan |
| --- | --- | --- | --- |
| Discovery, adapters, view | same: the daemon reads files, no model | same | same |
| The assessment | the builder's Claude Code session, plan usage | that session, dollars | a Codex session with the skill, plan usage |
| A product eval's own model calls | never run by 10db in slices 1–4; on the project's own key | same | same |

### Tests

Per `.claude/rules/testing.md`:
- one pure test of the marker rule table and the gate-report adapter;
- one test through the wiring on a real temp git repo, where a manifest naming an untracked path is refused;
- one e2e flow extended: a fixture project with a committed gate report opens on Evals and shows its suite.

## Slice 2: the covered-task marker and the "not run" item (Feature)

- Path-match a task's changed files against each suite's covered globs, after the gate, beside `forcedReview`.
- The card shows a marker: "<suite> · not run", "passing" or "regressed".
- The drawer shows **Evals this task touches**: before (the latest result on the base) and after (a run committed at
  the head, once one exists).
- A covered task's run leaves one Inbox item: "changes <path>; <suite> hasn't run on this; last on base: …", with
  the live command to run yourself.

## Slice 3: define an eval (Feature)

**New Eval** on the page, on a No Eval row, or from a Shape `PlanEval` files a normal task, "Write the eval for
<behavior>". Its brief carries ampsio's rationale: Decision, Evidence, Oracle, Coverage and bar, Models and
Execution. `PlanEval` widens with `decision` and `oracle`.

The lane drafts the cases, graders and free companion in the project's own format, following its own skill
(`llm-eval`, `backend-ai-agents.md`), and opens a PR. It never runs the live arm.

## Slice 4: `eval.definition_changed` (Feature)

A diff that touches a suite's definition paths emits `eval.definition_changed`, classified in code where it can be:
- bar lowered;
- cases removed;
- a golden's expected output changed;
- grader changed;
- a model judge added.

Focuses (the judgment feature) consumes it. It fires after the gate, beside `testValueFollowUpsAfter`.

## Slice 5: run the live arm from 10db (Core, later)

It runs the base commit's command in an eval sandbox:
- it opens only the suite's provider hosts and passes only its named secret;
- it stays under a per-project spend grant;
- it records the before/after verdict with 10db's keep rule.

It waits on the builder's call on unattended spend.
