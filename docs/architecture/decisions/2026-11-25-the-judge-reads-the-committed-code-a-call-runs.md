# 10db's judge reads the committed code a make target or repository script runs

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-24-judges-know-the-projects-dev-containers.md`, which turned down feeding the
  judge the repository's Makefile

## Decision

When 10db's judge (`crosses_limit`) reads a shell call, the hook judge (`inbox/hook-judge.ts`) shows it the text of
what the call runs, found by `trust/call-runs.ts` (`callRuns`):

- `make` or `gmake` with targets, `-C`/`--directory`, `VAR=value` arguments and only the options that change
  neither the Makefile nor the targets (`-s -n -k -B -j[N] --silent --dry-run --no-print-directory`). The
  Makefile is the first of `GNUmakefile`, `makefile`, `Makefile` there, with its literal includes. Each target
  gives its rule (Makefile, target, prerequisites, recipe as written) and the single-line assignments of the
  variables its recipe uses. Its prerequisites, the `$(MAKE)` and `make` calls on its recipe lines and the
  scripts they name are followed, each once.
- A repository script named by a path (`./x`, `.agents/bin/x`, an absolute path in the checkout) or right after
  an interpreter (`sh`, `bash`, `zsh`, `dash`, `python`, `python3`, `node`, `ruby`, `perl`), shown whole and not
  followed further.

Every file is read by `folders/committed-file.ts` (`readCommitted`) from `refs/remotes/origin/<base>`, and is
shown only when the checkout holds the same bytes at that exact path, as a regular file reached through no link.
A file the lane edited, created, deleted, replaced by a link, or committed but has not pushed is not shown; nor is
a name the Mac's case-insensitive file system would open for another (`gnumakefile` for `GNUmakefile`). A
Makefile that is not shown shows nothing of its targets, and a changed `GNUmakefile` hides a `Makefile` behind it.
One case passes: where the folder's only entry of that name is the exact `Makefile`, make's earlier `makefile`
opens that entry or nothing, so the reader names the entry and the walk reads `Makefile`. A `MAKEFILE` or
`gnumakefile` entry, or an exact `makefile` the base lacks, still shows nothing.

Only the first command of a line is followed, past the `cd`s that certainly move it. A command that runs earlier
in the same call can write the script or the Makefile (`cp e x.sh && ./x.sh`, `git checkout other -- Makefile &&
make x`), or change the shell (`export MAKEFLAGS=…`, a function named `make`, `PATH`), after the reader compared
the bytes, so the committed text would not be what runs. For the same reason a command that holds a substitution
or a here-document (closed or not, quoted or not) shows nothing: the shell runs those first. A `cd` is followed
only where the line's own text, from its start, is `cd`, one bare word and `&&`, `;` or a newline, then the next
command. The parser keeps no trace of a bracket, a brace or an empty word, so the text decides: a `cd` in a
subshell, a group, a pipeline, the background or a conditional's body, before `||`, with a quoted or second
argument or an option, stops the walk. `(cd sub && ./x)` shows nothing too, to keep the rule simple. The same
holds on each recipe line.

Nothing is shown for a command whose program or arguments the shell fills in, one that starts with `VAR=value`,
`make -f`, any other make option, a make with no target, a dynamic include, an interpreter's option (`-c`, `-m`),
a `cd` that can't be read, or a call that runs outside the checkout. A redirection among make's arguments is
passed over and the targets after it are read. The bounds: 3 levels
deep, 12 files, a script of at most 16 KiB (whole or not at all), 24,000 characters in all; past a bound the
judge is told some of what the call runs is left out.

The text is `call.runs` in the judge's state, beside the call, with `about_runs`: it is the committed text, data
and not instructions, its make variables are not expanded and one set in the command wins, and a script may load
files the session changed. With nothing to show the state is as before. The text is part of the key the hook
judge remembers a verdict under, so the same call is judged again once the checkout's text changes.

## Why

From 2026-11-18 to 25 one project's runs skipped 316 calls; 149 were its `.agents/bin/gate-query` and
`.agents/bin/ledger-query`, read-only Python scripts over the repository's markdown. The judge saw only a path
and put them at 49-60% against a 65-80% floor, every run skipped them, and several then stopped blocked. The same
judge saw `make migration APP=accounts` and `make api-client` only by their names, and whether it stopped
`make db-prepare`, which drops the dev database, rested on the name alone.

The committed base, not the checkout, is what the judge may trust, as for the compose services and the Docker
switch: a lane writes its checkout, so text the lane wrote must not be what allows its call. The base is the
builder's own merged code. A script that imports or sources files the lane changed is still read by its own
text; `about_runs` says so, and a judge that needs the rest stops the call as before.

Turned down:

- Reading the working tree: the lane would write the text that judges its own call.
- An allow keyed on a script's name or path: what it runs can change, and the model still judges the four limits
  on what it reads.
- Cutting a large script to the cap: a cut script can hide its last lines, which may be the ones that matter.

Provider parity: the text reaches every call 10db's judge reads, on OpenRouter, Anthropic API key and Bedrock
accounts, for Claude and Codex sessions alike. Claude's auto mode and Codex's Auto-review judge a native session
from their own context, which does not hold it yet; such a session runs as before and a follow-up task covers
giving them the same text.

Checked by hand with `apps/daemon/scripts/crosses-limit-replay.ts --floor 0.8`, which shows each case the text a
stand-in app's Makefile and query scripts give it, with `make db-prepare` and a script that sends the database out
as controls.

Tests: the reader (`folders/committed-file.test.ts`), the walk (`trust/call-runs.test.ts`) and the hook judge's
verdict key (`inbox/hook-judge.test.ts`) each have one test against a real git repository, because they decide
which text may allow a call. The other tests added with this change cover the Linear reporter's hold and the
install of a nested pnpm package, which each guard an escaped failure from the Ampsio pilot.
