# Evals B: discovery stays current, and By Model answers "can I swap this model?"

**Size: Feature.** Builds on `docs/superpowers/specs/2026-11-25-10db-evals-design.md` (slice 1 and change A are
merged: #875, #880). No migration: the manifest stays in `app_settings`. One implementer, end to end.

## Brief

**What changes for you.**
- **No Eval stays current by itself.** The assessment teaches 10db how this project marks a piece of LLM work:
  ampsio's `@register_task`, orgtools' workflow specs, or an SDK call. 10db then finds every such site at each HEAD
  with `git grep`. A site in a file no suite covers joins No Eval, with its `file:line`. A new LLM task shows up the
  commit it lands, with no new assessment.
- **"Since the assessment" line.** When HEAD has moved past the assessed commit, the page says what changed and
  offers Copy the Ask: new eval files nobody linked, new uncovered LLM work, manifest paths no longer at HEAD.
  It stays on the page and raises no Inbox item, since nothing breaks.
- **By Model tab.** One row per model the project has graded:
  - the suites it passed out of the suites it ran, and which ones it failed;
  - the cost of one run of each, and p50 latency;
  - "Compare with" picks a second model and shows both side by side per suite, with the cost difference.

  ampsio's question "can SMART move to gemini-3.8-flash?" then reads straight off the page: it fails
  column_mapping only, at about +11% cost. The numbers come from files already on disk.

**What it buys.** The eval backlog doesn't go stale between assessments, and a model swap is one screen instead of
a `run_tier_evals` run or a by-hand read of reports.

**What could go wrong, and how we'd know.**
- *A pattern that is too broad* fills No Eval with noise. Each pattern shows how many sites it found, and the
  assessment is told to keep that count close to the registry's own.
- *Models compared on different evals.* A model's result for a suite is its newest run. When that run's
  fingerprint differs from the suite's newest run, the cell says "older eval", so you never compare across a changed
  dataset without seeing it.
- *`git grep` on a big repo.* It reads the object store at HEAD, capped at 2,000 matches and run once per HEAD. The
  plan measures orgtools' time before and after.

**Calls you might disagree with.**
1. **Stock SDK patterns are a fallback only.** They run only when the manifest records no pattern. In both your
   repos, SDK imports are plumbing (71 files in orgtools), not units of work.
2. **The drift line stays on the page and raises no Inbox item.** It's information, not an ask.
3. **By Model reads only committed and local results.** It never runs a candidate model; that's slice 5.

**Needed from you:** nothing.

## Parts

1. **Contracts** (`packages/contracts/src/evals.ts`):
   - `EvalManifest` gains `callPatterns: [{ label, regex, glob }]`, capped at 20. The regex goes through
     `new RegExp` at the boundary, and a bad one is refused.
   - `EvalGapDto` gains `source: 'assessed' | 'found'`.
   - `EvalsDto` gains `drift: { since, newEvalFiles, newGaps, missingPaths } | null` and
     `callSites: { label, count }[]`.
   - New `EvalModelsDto` (per model: suites run, passed, failed keys, cost, latency, and per suite the newest run's
     result with its fingerprint match) and `EvalModelsQuery` (`compare?`).
2. **Git:** a read-only `grepAt(repo, rev, regexes, globs, maxMatches)` runs
   `git grep -n -I -E --no-textconv <rev> -- <:(glob)…>`, in the object store only and capped, like `survey`.
3. **Daemon** (`apps/daemon/src/evals/`):
   - `call-sites.ts` matches the manifest's patterns, or the stock SDK table when there are none. It's a pure rule
     table plus the `grepAt` wiring.
   - `build.ts` turns found sites outside every covered glob into gaps (`source: found`), next to the assessed ones.
   - `drift.ts` compares HEAD's findings with the manifest's commit.
   - `models.ts` builds By Model.
   - Route: `GET /projects/:id/evals/models?compare=`.
   - The skill's assessment section adds a step: record `callPatterns` and check each one's count against the
     registry.
4. **Desktop** (`views/evals/`):
   - the "Since the assessment" line;
   - No Eval rows show `file:line` and "found" or "assessed";
   - the By Model tab: a raised table, with Compare with as a `Select`. Status stays text and dots, never pills.

## Provider parity

Everything here is the daemon's own `git grep` and file reading. It runs the same on a Claude plan, Bedrock, an API
key or a ChatGPT/Codex plan, and calls no model. The assessment that records `callPatterns` runs in whichever agent
the builder pastes the ask into, through the same skill.

## Tests

`.claude/rules/testing.md`: few, each guarding a rule table or the real thing.
- One pure test of the stock call-site table and the pattern check: a bad regex is refused, and a too-broad glob is
  counted.
- Extend `service.test.ts`'s real-git test: a recorded pattern finds a new site in a commit, the site shows as a
  found gap, and drift names it.
- Extend `project-trust.spec.ts`: By Model lists `acme/model-b` failing `ingest.mapping`, and Compare with
  `acme/model-a` shows both.
- Measure `git grep` time on orgtools before and after, and put the numbers in the PR.

## As built

- A call pattern has `globs` (one or more), not one `glob`: git's pathspec has no `{a,b}`. Its `regex` is POSIX
  extended, as `git grep -E` reads it; the boundary refuses what `new RegExp` refuses and JS-only syntax (`\d`, `\b`,
  `(?…)`, lazy quantifiers).
- By Model is `GET /projects/:id/eval-models`, not `/evals/models`, where `models` would be read as a suite key. It
  takes no `compare` query: every model's per-suite results are in the answer, and Compare with joins two in the UI.
- Nothing is searched before an assessment: No Eval stays the Copy the Ask empty state until then.
- `git grep` on orgtools (4,472 files), through the dev daemon: a warm read 0.11 s before and after; the first
  read at a new HEAD adds about 0.7 s with the six stock patterns (they run only when a manifest records none),
  about 20 ms with one recorded pattern.
