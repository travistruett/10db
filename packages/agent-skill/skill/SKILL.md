---
name: 10db-task
description: Use when the user asks to create, add, file or queue a task, card or ticket in 10db (the local Claude Code factory app), or to edit, remove or start one, e.g. "create a task for this in 10db", "put this on the 10db board", "file that as a bug", from any Claude Code session. Also use to list, record or supersede 10db Knowledge (principles and decisions) when you learn a rule or make a choice worth keeping, and to assess or fix a 10db project's hazards (lockfiles, migrations, the commands that write them), e.g. after a project is added or when its hazards look wrong, or its evals (the suites, their bar and the LLM work with no eval), and to read or verify a project's settings (gate, delivery, base branch, account, rigor, areas) or what a task depends on.
---

# Create and manage 10db tasks

The running 10db app takes tasks over a local API. `tendb.mjs` (next to this file) finds the app,
reads its token, checks a draft against the New Task form's rules and posts it. Talk to the app only
through it: never `cat`, echo or interpolate `ui-token` (not even in `$(...)`), and never print it.

```
T=~/.10db/skills/10db-task/tendb.mjs
node $T context                          # projects for this repo: areas, default rigor, kinds, open tasks
                                         #   (each with dependsOn, rigor, effectiveRigor and kinds)
node $T project <projectId|name>         # one project's settings; reads only
node $T areas <projectId> <path>...      # which areas repo-relative paths fall in
node $T create <projectId> <draft.json> [--dry-run]
node $T edit <taskId> <patch.json> [--dry-run]   # title, description, acceptanceCriteria, rigor, kinds
node $T remove <taskId>                  # a task that has never started
node $T start <taskId>                   # as the card menu's Start does
node $T join <taskId> <batchId>          # start a task inside an open batch: one branch, one PR
node $T goal <projectId> <brief.md> [--dry-run]  # adopt a goal brief (goals spec §11)
node $T plan-import <projectId> <bundle.json> [--dry-run]  # import a planning effort's bundle into one Plan
node $T hazards <projectId> [additions.json] [--dry-run]  # print hazards, or add to them (never removes)
node $T evals <projectId> [manifest.json]  # print the project's eval suites, or record an assessment's manifest
node $T knowledge <projectId> [--q <text>] [--kind ...] [--scope ...] [--shelf current|past|all] [--page <n>]
node $T decision <projectId> <decision.json> [--dry-run]   # record a decision
node $T principle <projectId> <principle.json> [--dry-run] # record a principle
node $T supersede <dec_…|pri_…> <changes.json> [--dry-run] # replace a current decision or principle
```

**Landing:** related tasks go in one batch by default (start the first, `join` the rest), not one PR
per task. The builder works in big shifts and prefers fewer, larger landings.

## Create

The builder files tasks by describing a problem; they never copy a draft into the app. Create the
task as soon as it is drafted, then report it. No confirmation step: a wrong task is edited or removed.

1. **Project.** Run `context`. One match (`"matched": 1`): use it. Several: ask which. None: it
   lists every project; ask which, or say this repo isn't a 10db project.
2. **Draft** from the conversation and the code it touches:
   - **title**: the plain-words what, a few words on one line, under 200 characters ("Odd files
     can't freeze 10db"). It is the task's one name, shown everywhere and the PR's title; 10db adds
     the commit prefix, so leave off `feat:` and the like. Say the outcome, not the activity.
   - **why**: always; `create` refuses a draft without one. One sentence, one line, at most 200
     characters, on why the task matters to the user: what they get, or what goes wrong for them
     until it's done, in their words where they gave them. It's what tells them later why the task
     exists, so say the reason, not the change.
   - **description**: what is wrong or wanted, where, and why it matters; name the files or views
     involved. State what the user reported; a cause or effect you inferred is marked as a guess.
     Leave the approach to the agent unless the user chose one.
   - **acceptanceCriteria**: one array entry per thing that must hold when done, each something
     someone could see or measure. The agent works until all hold; a reviewer checks each and asks for
     a test, and the gate runs anyway, so never add "tests pass" or "a test covers this".
     - ✗ Make search faster → ✓ Search shows results in under a second with 10,000 tasks
     - ✗ Fix the login bug → ✓ Signing in with an expired password says so, instead of showing a blank page
   - **areas**: find the files involved (search the repo for the view, module or command named),
     run `areas` on them and use the areas they fall in. With one area, use it without searching.
     Only the project's area names are valid; hazards (migrations, deps, harness) are not areas.
   - **dependsOn**: ids from `openTasks`, only when this work needs another task finished first.
   - **kinds**: keys from `kinds` (security, auth, migration, dependency, schema, infra, ui, docs, or the
     builder's own), only when the user says the work is of that kind. Leave it out otherwise: 10db's rules
     (areas) and its judge add kinds on their own. A kind you give pins.
   - **rigor**: leave it out, so 10db sizes the task (rules, then the judge; the project's default without one).
     Give `light`, `standard`, `careful` or `critical` only when the user names one; it pins, and the daemon
     refuses one below a kind's minimum.
   - **external**: when the task comes from a Linear issue, link it, so 10db reports the task's runs and
     outcome on the issue (when Linear updates are on for the project):
     `{"kind": "linear", "id": "AMP-56", "issueId": "<Linear's own issue id>", "url": "https://linear.app/..."}`.
     Read `issueId` and `url` from Linear (`get_issue`); a Linear URL in the description alone links nothing.
     One issue links one task in a project until that task is removed, so `create` refuses a second.
3. **Write** the draft to a temp file (the session's scratchpad if there is one) and run `create`.
   If it reports problems, fix the draft and rerun.
4. **Report** the task id, title, areas and criteria in a few lines, and say it can be changed or
   removed.

Several tasks from one conversation: create each, then report them together.

**Preview first** only when the user says dry run, preview, "draft it" or "don't create": run
`create ... --dry-run`, show the draft and create nothing until they say so.

## Edit, remove, start

- **Edit** an open task's title, why, description, criteria, rigor or kinds with a patch file holding only
  the fields that change. Areas can be edited too (`"areas": [...]`, the project's names) while none of
  the task's runs holds a claim: not while it runs. Dependencies can't be edited: remove the task and
  create it again while it hasn't started.
- **Remove** works only on a task that has never started and that no open task depends on. A task
  that has run is cancelled from its batch on the Board (Abandon) instead; the daemon's refusal says so.
- **Start** only when the user asks. It starts work and spends usage, as the card menu's Start does.
  The daemon can still refuse after answering (a dirty checkout, a git trust card); that refusal lands
  in the Inbox, so check it if the task doesn't move to In progress.

## Import a planning effort

`plan-import` hands a whole planning effort (documents, findings, decisions, tasks) to 10db as one Plan. The bundle
is a `PlanBundle` JSON file; its document bodies may be `bodyPath` files beside it. The daemon reads the files itself,
so pass the path, never the text. Always run `--dry-run` first and show what it would write. The bundle must not sit
under `/tmp`, the data dir or a worktree root, and no file may have a second hard link. Importing the same bundle id
again adds only new revisions and versions. The builder Converts the Plan in the app; importing starts nothing.

## Record what you learned: principles and decisions

Knowledge is the Knowledge view's decisions and principles. Recording what was learned is something you just do,
not a request for permission: the builder edits or withdraws a record in the view, and a wrong one costs them a
click. Read first, write second, report after.

**Record** when you learned something the next agent or session would otherwise relearn, and you can say why:

- a **principle** is a rule for how work is done ("Tests wait on a condition, never sleep"), as one instruction
  of at most 500 characters. Give `kind` (`policy` must, `heuristic` prefer, `belief` context), a `topicKey`
  such as `context.soft-ceiling`, and a `rationale` with the evidence (what you measured or saw, with numbers).
- a **decision** is a choice made among options, with `question`, `choice` and `rationale` (why this and not the
  alternatives, and the evidence).
- the **builder's own words** go in `quote` (principle) or `source.quote`. Never put words in their mouth.

**Leave it to the builder** (say what you would record and let them decide) when:

- it is a preference or policy about the builder's own work, money, people or product that they have not stated;
- it would contradict a current record you did not write, other than by superseding it with new evidence;
- you are guessing, or it holds for this one task only: that belongs in the task, plan or commit, not Knowledge.

**Steps**

1. `knowledge <projectId> --q <words>` (add `--shelf all` to see superseded ones). It lists the project's records
   and the builder's own; a `you` place is All Projects, which applies in every project.
2. Same topic already there? `supersede` it by id rather than adding a second record. A principle that reuses
   a current `topicKey` at the same place replaces that one by itself.
3. Write the JSON file and run with `--dry-run`: it shows what would be written and what it would replace.
   `scope` is `project` by default; use `you` (All Projects) for a rule about how agents work in general, and
   `area` plus `area` (an area name) for one part of the code. Only the fields the daemon's schema names are
   accepted; it answers a mistake word for word.
4. Run it without `--dry-run`, then report the id and what it replaced in a line. The record's source says
   it came from this skill.

`supersede` takes only the fields to change (`statement`, `kind`, `topicKey`, `rationale`, `scope`, `area` for
a principle; `question`, `choice`, `rationale`, `scope`, `area` for a decision) and keeps the rest. Moving a
`you` record into a project needs `projectId` too. It only works on the current record; a 409 names the one that
is current. There is no command to withdraw or retire: that is the builder's, in the Knowledge view.

## Verify a project's setup

`project` prints what the project's Settings hold, and `context` what each open task depends on. Both only read.
When the builder asks you to check a project, or after one is added or changed, compare:

- **gate**: `gate.command` is the command the repo's own docs say proves a change (its AGENTS.md or Makefile), and
  runs from the repo root. `changedCheck` and `precheck` are optional faster checks; null is fine.
- **delivery and landing**: `delivery.label` is "Open a Pull Request" or "Commit Directly". Under pull requests,
  `baseBranch` exists on origin and is the branch the repo opens PRs to, and `landing.label` says whether GitHub
  merges by itself or holds for the builder. Under "Commit Directly", Settings hides both and `note` says so.
- **account**: `account.label` is the account the builder meant for this repo; `fallbackAccount` takes over when it
  runs out, or is null.
- **defaultRigor**: what a task gets when no rule or kind sizes it.
- **areas**: every tracked file falls in one (run `areas` on a sample, or check a `catchAll` area exists).
- **hazards**: assess them as below.
- **dependencies**: each task's `dependsOn` names the tasks that must finish first; a chain reads backward
  from the last task.
- **dev login** (Settings › App Preview; `project` does not print it): the command that signs 10db's picture
  browser in to the app. It must work by itself every time: create its fictional user if that user is missing,
  run only against the dev database, be safe to repeat, and print one sign-in URL or path. It never signs in as a
  user the project's tests or e2e cleanup delete, and never touches a database that is not the dev one. When you
  write or review such a command in the repo, hold it to that. The builder's Check Sign-In button runs it and shows
  the page it signed in to or its error, and 10db checks it again when it changes, at start and once a day, with
  one Inbox card while it fails. It runs with `TENDB_APP_URL` set to the address being photographed; for a
  separate copy's own app it runs in the copy's folder with `TENDB_COPY_ID` set too, and must then sign in to
  that copy's database.
- **copy app command** (Settings › General, under Teardown Command): for a project whose separate copies serve an
  app of their own. Run in the copy's folder under the gate's sandbox with `TENDB_COPY_ID`, it starts the copy's
  app if it is not running and prints its address last (an http origin on this Mac, never the shared App
  Address), safe to repeat. With it, pictures of a copy's work are taken in the copy's app before it lands; blank,
  they are taken in the shared app after the landing. The Teardown Command stops that app.

Report each value with what you expected and say which differ. Never change a setting from here: hazards are the only
thing this skill adds to, and the builder changes the rest in Settings.

## Assess a project's hazards

A hazard is something only one task may change at a time: its globs make an edit need the claim and
flag an unclaimed change after a session; its commands are word prefixes the guard refuses until the
claim is held. 10db adds every project with one stock list (pnpm, npm, yarn, bun, cargo, drizzle), so a
repo on another stack, or one that wraps its tools in `make` or `docker compose exec`, is under-covered.
The builder never edits hazards by hand; you assess and fix them.

1. **Read the current list:** `hazards <projectId>`.
2. **Gather evidence from the repo, never from memory:**
   - Tracked lockfiles and manifests anywhere: `git ls-files | grep -E '(^|/)(uv\.lock|poetry\.lock|Pipfile\.lock|requirements[^/]*\.txt|pyproject\.toml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|package\.json|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?)$'`.
     A root-only stock glob such as `pnpm-lock.yaml` misses a nested one; add `**/` forms.
   - Migration folders (`git ls-files | grep /migrations/`), and generated folders the repo declares.
   - The commands that write them, from the repo's own words: `AGENTS.md` files, `Makefile` targets,
     `package.json` scripts, compose services, `docs/development`. Prefer the entry points the repo
     tells agents to use (`make migration`, `make backend-lock`) plus the tool's own writing commands
     (`uv lock`, `uv add`). A command the guard sees through a wrapper it doesn't unwrap
     (`docker compose exec <svc> …`, `make …`, `python3 script …`) needs its literal prefix listed.
   - Commands that apply migrations to the shared database count too (`manage.py migrate`,
     `make db-prepare`), as the stock `pnpm db:migrate` does.
   - A prefix also catches read-only uses of the same command. When the repo has its own entry point
     for the write (`make migration`), list that and leave the check (`makemigrations --check`) free.
     When the write and the check share a prefix, list it anyway: a check that needs the claim only
     waits, while a missed write lets two lanes make clashing migrations. Never list `make gate`.
3. **Prove it:** with the merged list, run the guard's own `judgeToolUse`
   (`apps/daemon/src/guard/judge.ts`) through `pnpm exec tsx` from `apps/daemon` on the real command
   forms (with flags, args, `cd … &&`): each writing command is denied unclaimed and allowed claimed,
   each read-only one is allowed, and against the old list the writing ones were allowed. Keep the
   script in the scratchpad.
4. **Apply** with `hazards <projectId> <additions.json>` (a list of `{ name, globs?, commands?, scope? }`).
   It appends to the hazard of the same name, or adds a new one (needs a glob; scope `project` unless
   given), reports how many tracked files each new glob covers (0 means a wrong glob), and refuses
   removals and scope changes. Rerun it: it should say nothing is left to add.
5. **Removing or loosening** a hazard only makes 10db less safe: never do it here. Say what you'd
   remove and why, and let the builder decide. A hazard only makes a lane wait for a claim; a command
   no lane should ever run (one that touches a remote or production database, or deploys) is not a
   hazard. Report it to the builder as a guard gap instead.
6. **Report** what you added and the evidence for each entry, in a few lines.

## Assess a project's evals

10db reads a project's eval files at HEAD and its eval results in the checkout, and shows them; it defines no eval format and runs no eval.
Result files and eval files are found by name. What no file name says (which code a suite covers, its bar and
commands, the LLM work with no eval) is recorded as a manifest beside the project's settings, never a file in the
repo. 10db assesses on its own, with one model read of the eval files and the code that calls a model, when a
project is added, when a commit changes an eval file and when the builder presses Assess now; this section is the
deeper pass from your own session, which explores the repository and can find what that read misses. Your manifest
replaces the one 10db recorded, and 10db's own scheduled assessment never replaces yours.

1. **Read what 10db found:** `evals <projectId>`. It lists the suites, their latest result, the eval files no suite
   links and the gaps (unknown until you record a manifest).
2. **Gather evidence from the repo, never from memory:**
   - The project's own LLM-task registry and its eval bindings, and the eval files (`git ls-files | grep -i eval`).
   - The bar as the repo words it (a gate's minimum, a README or AGENTS.md line), kept in its words.
   - The free and live commands, from `AGENTS.md`, the `Makefile` or `package.json` (the free arm runs in the
     project's own gate, such as a replay; the live arm calls a paid model).
   - The code each suite covers, as globs that match tracked files.
   - The LLM work with no eval, where the model call is (`path` or `path:line`), and the repo's own words for why
     it has none.
   - How the repo marks one unit of LLM work: a decorator or base class of its task registry (`@register_task`),
     a workflow spec, or failing those an SDK call. That becomes a call pattern, which 10db `git grep`s at every
     HEAD, so a new task with no eval shows the commit it lands, with no new assessment.
3. **Never run a live eval.** Designing an eval doesn't grant paid calls. Read results; run nothing. The builder
   runs a suite's live arm with Run in 10db, only for a suite whose manifest entry has `live` (step 4).
4. **Write the manifest JSON** in the scratchpad: `{ "suites": [{ key, label?, bar?, definitionPaths, coveredPaths,
freeCommand?, liveCommand?, live? }], "gaps": [{ label, where, why }], "callPatterns": [{ label, regex, globs }] }`. A
   suite `key` is a result file's task (as `evals <projectId>` shows it) or a new key for a suite with no results
   yet. A `regex` is what `git grep -E` reads (POSIX extended: `[0-9]`, `[[:space:]]`, no `\d`, `\b` or `(?:`);
   `globs` are git pathspec globs, one per extension (`**/*.py`; no `{a,b}`). At most 20 patterns. With none,
   10db searches for the model SDKs' own calls, which in most repos are plumbing, not units of work.

   **`live`** (only with a `liveCommand`) is what the live arm needs from 10db's sandbox, so Run can offer it:
   `{ docker?, hosts?, envFiles?, loopback?, stopCommand?, timeoutMinutes? }` (default 60, at most 240).
   - `docker: true` when the command reaches containers (`docker compose exec …`). Its `envFiles` are the files
     compose reads under 10db's sandbox (`TENDB_SANDBOX=1`): the `env_file:` entries of its compose files and the
     project's `.env`, each a `.env*` path inside the checkout that exists as a regular file. Name only what
     compose needs there: ampsio's Makefile switches to `.env.example` under the sandbox, so it names none;
     orgtools names `.env`, `orgtools/backend/.env.dev` and `orgtools/frontend/.env`. A Docker suite opens no
     `hosts`: the containers keep their own network and their own keys. 10db passes the command no key.
   - `stopCommand` ends the work inside the container (ampsio: a `docker compose exec -T backend python -c …`
     that signals the `manage.py run_eval` process), because stopping 10db's side leaves it running.
   - `hosts` (domains, `*.example.com` at most; never a bare `*.com`) only for a suite that is not Docker and
     calls a provider from the Mac. `loopback: true` only for a command that calls a local server.
   - `models` (inside `live`) names the env var the live command reads its models from, so Try Other Models can
     offer them: ampsio `{ "env": "MODELS", "ids": "openrouter" }` (any provider id as given); orgtools
     `{ "env": "MODELS", "ids": { "choices": [{ "name": "gemini_3_7_flash", "model": "google/gemini-3.7-flash" }] } }`
     (only the project's own names, each with the model it is). Leave it out when the command reads no such var.
     Record the file that binds a suite's model (ampsio's `apps/llm/model_slots.py`) among its `coveredPaths`, so a
     model switch marks the suite not run, also when the project is assessed through Codex.
   - When unsure, leave `live` out: a suite without it has no Run.

5. **Apply** with `evals <projectId> <file>`. It refuses, and keeps nothing, when a `definitionPaths` entry is not a
   tracked file or a `coveredPaths` glob matches no tracked file; fix those and rerun until it refuses nothing.
6. **Check each call pattern's count** in the output against the registry's own count (the tasks it registers).
   Far more means the pattern is too broad and fills No Eval with noise; tighten it and apply again. A gap the
   pattern finds outside every `coveredPaths` is listed as `found`, so name it under `gaps` only to add the
   repo's words for why.
7. **Report** the suites linked, the gaps, each call pattern with its count, and the evidence for each, in a few
   lines.

The builder files a task that drafts an eval with New Eval on the Evals page (header, a No Eval row, or a goal's
proposed eval). Its brief carries the rationale (Decision, Evidence, Oracle, Coverage and bar, Models, Execution):
draft the cases, graders and free companion arm by the project's own eval skill, open a pull request, and never run
the live command or any paid model call.

## Errors

| Message                                          | Do                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 10db isn't running / couldn't reach              | Ask the user to open the 10db app, then rerun                                                 |
| refused the token (401)                          | The app restarted; rerun once, then ask the user                                              |
| doesn't fit 10db's New Task rules                | Fix the listed fields; don't bypass the check                                                 |
| failed with 400                                  | The daemon's own validation; fix the draft from its message                                   |
| failed with 409                                  | The task has started, is done, or has dependents; the message says which                      |
| doesn't fit 10db's Knowledge rules               | Fix the listed fields from the daemon's own schema; the file names a field it doesn't have    |
| isn't the one this 10db ships                    | The app updated. Restart 10db; if it persists, Settings › Agent skill shows the install error |
| answered something this skill doesn't understand | The action may have happened: run `context` to check before retrying                          |
| In Codex, the sandbox may block localhost        | Allow network access for the Codex session, then rerun                                        |
