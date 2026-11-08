# A project's hazards are read from its repository: additions apply, removals ask

- **Date:** 2026-11-08
- **Amends:** the hazard part of `docs/superpowers/specs/2026-10-29-10db-reads-your-project-design.md` §4.2–4.3
  and §7.2: "changing a project's areas or hazards without the builder's yes" was an anti-goal there. For
  hazards, only taking an entry out now asks.

## Decision

**What is read.** `readRepoText` (`apps/daemon/src/hazards/repo-text.ts`) lists the tracked files of the
project's main checkout (HEAD, through `Git.survey`) and reads, from the object store of the commit HEAD
names (`Git.fileAt`: no link followed, nothing run), the `AGENTS.md` and `CLAUDE.md` files, makefiles, compose
files, `justfile`/`Taskfile`, `package.json` files up to three folders deep, the README and `docs/**/*.md`.
At most 60 files, 48 KiB each, 300,000 characters in all, 400 lines of 240 characters each; the names of helper
scripts are listed and not read. A file past a limit, or a link, is skipped and counted.

**Who is asked.** The text goes to the model that names areas (`createAreaNamer`, the fast tier) as data between
fences, each line numbered, with no tool and no file, in a folder of 10db's own. It answers JSON: additions
(a hazard, `glob` or `command`, the value, a reason, a file and a line) and removals.

**What passes.** `checkAssessment` (`hazards/check.ts`) takes nothing on trust:

- a command is at most six plain words, with no flag, variable or quote; it is not a check (a word such as
  `check`, `test`, `lint`, `gate`, `plan`, `diff` anywhere in it) and not the project's gate or pre-check command
  (or the start of one); a bare program (`make`, `python3`, `docker`) names no change;
- its evidence is a line, in a file the model was given and the repository tracks, that contains the command's
  last word (the make target, script or subcommand);
- a glob is a valid path pattern, matches at least one tracked file (never saved otherwise), and not more than
  half of a repository of more than twenty files; its evidence is the first tracked file it matches, whatever
  the model cited;
- the hazard is an existing one or a new name that is not an area; a new hazard needs a glob in the same
  answer, since a hazard stores at least one path; nothing already held, builder-removed or builder-kept
  is proposed again; at most 40 entries.

A reason is cut to one clean line of 200 characters, with control and formatting characters removed.

**Additions apply on their own** (`applyHazardAdditions`, `packages/db/src/store/hazard-assessment.ts`), in one
transaction with the record of the read, because an addition only makes 10db stricter. The record is the app
setting `hazard-assessment:<project id>`: each addition with its hazard, kind, value, reason, evidence and time,
the entries the builder took out (`declined`), the removals the builder kept (`kept`), the commit read and
when. No schema change.

**Removals and narrowings never apply on their own.** Files a lane can write feed the model, and could talk it
out of a hazard. A removal the model proposes (the hazard must hold the entry and the evidence must be a
tracked file), and an earlier addition whose evidence the repository no longer shows (its line's file no
longer names the command, or its glob matches no file; found by code, no model involved) are listed on one
Inbox card per project (`hazard-removals:<project id>`). It is replaced by each look and withdrawn when a look
finds nothing to remove. **Remove them** takes the entries out in the answer's own transaction (a hazard left
with no path goes too, and the store refuses that while a task holds it), **Keep them** records them so they are
not listed again.

**Settings › Areas and hazards** lists each addition in plain words (`Added the command make backend-lock to
"deps": Updates the backend lockfile.`, `Found in Makefile, line 6`) with an **Undo** that takes that one entry
out and is remembered, and a **Look again** (`POST /projects/:id/hazard-assessment/look-again`) that runs the
same assessment on the current main checkout and says how many it added and how many removals wait in the Inbox.

**When it runs.** In the background, 15 seconds after the project is added (`ProjectCreated`) and after a
commit recorded by the commit tool (`CommitRecorded`) whose paths include a manifest, lockfile, makefile,
compose file or `AGENTS.md`; calls close together make one, and a look already running is joined.

**When it can't.** With no model, a slow one (90 s), a failed one or an answer that isn't the agreed JSON, nothing
changes, not the stock hazards and not the previous list, and Look again says so. The project works as it did.

## Why

The stock list can't know which `make` targets, compose services or scripts a repository uses to change its
lockfiles and migrations; on Ampsio that was `make migration`, `make backend-lock`, `make frontend-lock` and
`python3 amps/dev_export.py`, said by `amps/AGENTS.md` and `docs/development/local-docker.md`. The builder
wanted this behind the scenes, with a say only over loosening.

The asymmetry is the point: a hazard added by mistake costs some waiting and has an Undo, so asking about it
would be noise; a hazard taken out by a model that read a lane-written file is how a lane could lift its own
guard. The checks are in code because the model reads repository text, and so can be steered by it: a model
can only choose among entries that pass, each of which must point at a real line or file.

Turned down: asking for a yes on additions (the builder said no); running `make -n` or the package manager to
list targets (runs repository code); giving the model Read/Glob/Grep (its output would still need the same
checks, and the tools add a sandbox and a workstream for no gain, since the relevant files are few and small);
a table for the additions (one JSON value per project is read only by Settings and this step).

Limits: the read is of HEAD of the main checkout, and a commit made in a separate copy (worktree) changes no
file there until it lands, so such a commit starts a look at the main checkout as it is; the next commit of a
watched file, Look again or a new project reads it after the landing. Hazards the model proposes for a repository
whose docs do not say how its lockfiles are written are not guessed.
