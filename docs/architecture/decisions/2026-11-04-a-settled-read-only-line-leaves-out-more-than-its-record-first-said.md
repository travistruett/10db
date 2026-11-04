# A lane's settled read-only line leaves out more than its record first said

- **Date:** 2026-11-04
- **Amends:** `decisions/2026-11-03-a-lane-runs-read-only-commands-without-a-card.md` (which calls are settled)

## Decision

As merged in #471, that record settled every line of read-only commands in the plain grammar that named no path
a lane may never read. Work after the merge narrowed that and wrote the narrowing into the record in place. By
the rule in `README.md` those changes were amendments, so this file is the amendment: it states what changed
after #471. The record's text stays as it is and holds the full detail; this file names which parts came later.

**Choices added after the merge.** Each leaves a call to today's judgement rather than settling it:

- **`ps` that may print environments (#491).** `-E` in a dash bundle (`ps -Eww`), or a word with no dash holding an
  `e` or `E` (`ps eww`). The check also catches an option's value (`ps -o pid,etime`), on purpose.
- **Attached short options (#491).** The merged record already judged every word that is not a bare option, but
  the code skipped these. It now judges every tail of a single-dash word as a path (`-f/x`). New with that: a
  single-dash word over 256 characters is not split and leaves the call unsettled.
- **Endless devices (#491) and the directories that hold them (#501).** A path that names `/dev/zero`,
  `/dev/urandom` or `/dev/random`, or `/dev` or `/`, whichever command reads it. #501 moved the comparison from
  the spelling to the path as the kernel opens it, so a `../` chain or a link to a device counts too, and a word
  with no single real path is unsettled. `ls /dev` and `ls /` are unsettled as a result.
- **The working directory (shipped with this file).** Relative words are judged from the `cwd` of the PreToolUse
  hook's request, not the lane's copy. A hook `cwd` that is not an absolute path leaves the call unsettled.

**A gap accepted (#501).** A link met only while a command walks a directory it was given (`grep -R x .`) is not
seen, so such a line stays settled. The cost is one core until the Bash timeout.

**Not amendments.** These edits to the record are corrections of fact, which `README.md` allows in place, and stay
there: the git option refusals as the code has them (`-O` and `--open-files-in-pager` for `git grep` only, `--text`
is not `--textconv`, #501), and the examples of which spellings of a device path are unsettled.

Nothing else in the record changes. In particular, a read-only line that clears these checks is still a settled
allow with no classifier and no card.

## Why

- **`ps`.** The merged record's safety argument was about writes and file paths, and `ps` uses neither, but `-E`
  can print a process's environment. Claude Code's own process runs outside the sandbox, so the lane's env denial
  does not cover it. srt's policy looks like it returns no other process's environment, but that was
  read, not run, so the guard does not rely on it. The word check is broad because a call it catches by mistake
  only keeps today's judgement.
- **Endless devices.** The record gives up the classifier's `hard_deny` for CPU load on the ground that a read-only
  line is as light as the commands it names. `cat /dev/zero | wc -c` is not, and the endless-loop ask looks only at
  background calls. So "What the call gives up" now names the exception.
- **`/dev` and `/`.** The guard knows no program's options, so it cannot tell a listing from a recursive read.
- **The working directory.** Claude Code carries a `cd` from an earlier Bash call into the next, so a settled line,
  which has no `cd` of its own, can still run outside the copy's root. That Claude Code updates the hook's `cwd`
  after such a `cd` is taken from its documented meaning, not proven live.
- **The gap.** The harm is bounded, and the guard judges the words on the line, not what a walk meets.

Turned down: moving the text out of the record into this file (a further large edit to a merged record, and the
code cites that record for what it settles); widening the README to allow a choice to narrow in place while a
feature is still being hardened (the limit would rest on a judgement of when hardening ends, and an agent could
not tell from the record whether a given edit was allowed).
