# Evals page: assess on its own, and a polish pass

**Size: Feature** (one implementer end to end, one review that blocks only on bugs, one extended e2e flow). The
assessment calls a model the way the hazard assessment does; nothing new crosses a hard limit.

## Brief

**What changes for you.** You never copy a prompt. 10db assesses a project's evals on its own when the project is
added and when a commit changes its eval or LLM files, and **Assess now** runs it on demand. The page says what it is
doing in plain words ("Assessing your evals…", "Assessed 2 h ago"), never commit hashes or "no model ran". An empty
project offers **New Eval** and **Assess now** as its two actions. Every state of the page (empty, not yet assessed,
assessing, assessed, drift, No Eval, By Model, the drawer) gets a copy and layout pass.

**What it buys.** The Evals page fills itself in, and reads like a product rather than a debug view.

**What could go wrong, and how we'd know.** A model that names a path the repo doesn't track: the existing manifest
checks refuse it, so nothing wrong is recorded and the page says the assessment found nothing it could use. A slow or
absent model changes nothing (as hazards). Cost: one model call per assessment on the project's account, run only on
add, on a commit touching eval or LLM files (bursts joined) and on Assess now.

**Calls you might disagree with.**
1. The assessment is a single model read of files 10db picks at HEAD, with no tools, like the hazard assessment, not
   an agent session that explores. It is cheaper and contained; it may miss what only exploring finds. The skill's
   "Assess a project's evals" stays for a deeper pass from your own session.
2. A Codex-only builder: 10db asks the default non-Codex account, as the area namer does; with none, the page says it
   can't assess on its own and offers the copied prompt as the fallback.

**Needed from you.** Nothing; screenshots of each state before the review.

## Parts

1. **Daemon assessor** (`apps/daemon/src/evals/assess.ts`, wired in `daemon/start.ts`), modelled on
   `hazards/` (read its `AGENTS.md`): pick files at HEAD through `Git.survey`/`Git.fileAt` (eval definition files,
   the files that reference them, the LLM call sites the stock call patterns find, the project's eval skill), capped by
   size; give them to a model of the project's account (the area namer's `createAreaNamer` pattern and Codex fallback,
   at a tier fit for reading code) as numbered data lines with no tool; parse a `EvalManifest` with zod; record it
   through the existing `service.record` path, whose checks stay the gate (untracked paths refused). A refused or
   empty answer records nothing and keeps the reason for the page. Schedule like `subscribeHazardAssessment`: on
   `ProjectCreated` and on a `CommitRecorded` touching eval definition files, eval skill files or files matching the
   call patterns, bursts joined; never while one runs for the project.
2. **Route and state:** `POST /projects/:projectId/evals/assess` (Assess now) and the assessment's state on the
   evals DTO (`idle` | `assessing` | `failed` with a reason, and `assessedAt`). Events refetch as today.
3. **UI pass** (`apps/desktop/src/views/evals/`):
   - Replace every Copy the Ask with **Assess now** (busy while assessing); keep the copied prompt only as the
     fallback where the daemon says it can't assess (Codex-only, no account).
   - Replace the byline with "Assessed <relative time>" (the commit in a tooltip), "Assessing…", or "Not assessed
     yet"; drop "no model ran" and "from the checkout's results".
   - Empty state: "No evals yet" with New Eval (primary) and Assess now.
   - The "Found by file names" and drift banners: one short sentence each, with Assess now.
   - Walk every state in the running app and fix what reads as jargon, crowds, truncates (the banner's cut-off
     button) or is inconsistent with other pages; list what you changed.
4. **Docs:** both evals `AGENTS.md`; the skill's assess section says 10db now assesses on its own and the skill is
   the deeper pass.

## Provider parity

| | Claude plan | Bedrock / API key | ChatGPT / Codex plan |
| --- | --- | --- | --- |
| Automatic assessment | the project's account, plan usage | the project's account, dollars | the default non-Codex account; with none, the page offers the copied prompt for a Codex session |

## Tests (`.claude/rules/testing.md`)

No unit test unless the answer's parser is a pure rule table worth one (then one). Extend the evals e2e flow
(`apps/desktop/e2e/project-trust.spec.ts`): with the fake model answering a manifest, Assess now fills the Suites tab
and the byline reads "Assessed".
