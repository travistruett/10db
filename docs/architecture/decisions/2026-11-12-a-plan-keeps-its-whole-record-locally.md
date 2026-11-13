# A planning effort's whole record lives on its Plan, in 10db's database, never in a repository

- **Date:** 2026-11-12

## Decision

- A planning effort's record lives on the Plan (`shapes`) in 10db's own database. That record is its documents
  with every revision and their sections, its intent, facts, experiments and names, its decisions with their
  alternatives, its review findings by round with their outcomes, its questions and its cost. Nothing of it is
  written into a repository.
- **It arrives by import.** `POST /projects/:projectId/plans/import` and the builder MCP tool `import_plan` share
  one service. A bundle is one JSON file, each document's text in a file beside it, named by a relative
  `bodyPath`. The bundle file may be anywhere but the data dir, and each body file must be a regular file at or
  under the bundle file's folder by real path. Every file is opened once, the whole read is capped at 16 MiB,
  and the text is kept byte for byte.
- **A re-import updates the same Plan.** Importing the same bundle `id` into the same project appends new
  revision numbers, versions changed entries and supersedes dropped ones. A revision number's text never
  changes: a changed text is refused until it is a new revision. After Convert, a re-import proposes
  `change_task` and additions against the tasks as they stand. It leaves a started task, a dropped task and a
  converted decision, principle or question alone, and says why.
- **On an imported Plan, the session cannot rewrite the record.** `propose_plan`, `write_spec` and
  `resolve_finding` are refused, so only a re-import changes it.
- **Export writes Markdown only outside every repository.** `POST /shapes/:shapeId/export` refuses a folder at
  or under a registered checkout, the worktree root, the data dir, a sandbox root or any git work tree. Each is
  read through links and for paths not yet made. The folder must be new, empty or this Plan's own earlier
  export (`.10db-plan-export`), and every file is opened with `O_NOFOLLOW`.
- **Convert pins each task to its section.** A task with a `planRef` gets a `task_context` row naming the exact
  revision and section it was made from, its shared sections and the record items it cites. Only a decision
  marked lasting is written to Knowledge; an effort-only decision is accepted and stays on the Plan.
- **A lane's brief carries its plan.** It gets its section and the shared sections whole, then the cited
  decisions, names, facts, open findings on its section and intent within 6,000 estimated tokens, naming the
  rest. The lane can read more through three read-only lane tools (`get_plan_section`, `get_plan_entry`,
  `find_plan_entries`) that answer only from its task's Plan.
- **Anchors are checked at session start against the base, and a stale one never reads as current.** The
  runner checks each cited code anchor against the workstream's current base with the daemon's own git, right
  after it reads that base and before the stop re-check. A check is kept per workstream, base commit and fact
  version, so it runs again when the base moves or a re-import versions the fact. An anchor reads current only
  when its excerpt was found at its line by this workstream's own check of that base and version; every other
  state says so in words.

## Why

The builder, during the remote-host planning effort: "I really want to stop doing docs PR, that sounds hacky
especially for an open source repo … make this part of the database otherwise we're leaking plans", and "how to
make 10db track everything we just learned with zero loss and everything is stored and easily readable /
structured". On Knowledge: "that's really for bigger decisions, principles, etc. Not really task/goal granular
stuff". On where it lives: "I think local … I just really don't like the idea of full plans going into the repo
forever."

Turned down:

- **Docs PRs:** the plans would land in the repository forever.
- **Knowledge as the store:** it holds lasting decisions and principles. An effort's facts and reviews would
  drown them.
- **A sync to a shared service:** the builder chose local first. Contributors come later.
- **A generic Markdown-to-bundle importer in the daemon:** turning prose into typed entries means reading
  English, which is where loss and paraphrase come in. Documents already import verbatim by `bodyPath`.
- **Full-text search for the record:** a Plan holds hundreds of items, so `find_plan_entries` searches in
  memory. An FTS table would need a hand-written migration. Search can move behind the same tool later.
