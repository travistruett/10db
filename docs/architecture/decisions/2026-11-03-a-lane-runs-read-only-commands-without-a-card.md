# A lane's Bash call made only of read-only commands is approved by the hook, with no card

- **Date:** 2026-11-03
- **Amends:** `2026-10-31-lanes-run-in-auto-mode-inside-the-sandbox.md` (what reaches the classifier or the broker)

## Decision

`judgePreToolUse` (`apps/daemon/src/guard/pre-tool-use.ts`) answers a sandboxed lane's Bash call with a
**settled allow** (`{ decision: 'allow', settled }`, sent to Claude Code as `permissionDecision: 'allow'`) when
`laneReadOnlyWords` (`guard/read-only.ts`) finds every part of the line a read-only command. Neither the
classifier nor a card follows. The guard's own checks still run first, so every refusal holds, and so do the
`allowed_domains` refusal and the endless-background-loop ask. Anything else is judged as before.

**Which commands count.** The ones a read-only step may run, judged by the same function:
`READ_COMMANDS` (`basename cat cd diff dirname echo find grep head jq ls pwd realpath rg sort stat tail test
tree true wc which`), read-only git (`blame describe diff grep log ls-files rev-parse shortlog show status`,
the subcommand first), and for lanes `ps`. Across `;`, `&&`, `||` and `|`, every part must be one of these
and nothing else. The line must be plain words in the read-only grammar (`plainCommandWords`): no `$`,
backtick, `$(…)` or `<(…)`, no variable, no subshell or group, no background `&`, no escape, and no redirection
other than `2>&1`, `>/dev/null` and `2>/dev/null`. The command word is a bare name: no path, no wrapper, no
assignment. Writing options are refused whatever the command: `find -delete -exec -execdir -ok -okdir
-fprint* -fls`, `sort -o --output --compress-program`, `tree -o -R`, `rg --pre --pre-glob --hostname-bin`, and
for git `--output --ext-diff --textconv`, plus `--open-files-in-pager` and `-O` for `git grep` only. The git
options are judged in two places (`gitRunsOrWritesReason` in `guard/read-only.ts` calls `gitVerdict` first):

- `gitVerdict` (`guard/git-rules.ts`) refuses `--output` for every verb, and `-O` and `--open-files-in-pager` for
  `git grep` only. `-O` means "open files in pager" only for grep, so `git log -SOption` is not refused, and
  neither is `git diff -O<orderfile>`. For grep, any short bundle holding an `O` is refused (`-n1Osh`),
  not just `-O`; pass a pattern that starts with `O` as `-e O`.
- `gitRunsOrWritesReason` itself refuses `--ext-diff` and `--textconv`. Git accepts any unambiguous abbreviation of a
  long option, so abbreviations of these two are refused as well (`--ext=…`, `--textc`). `--text` (treat files as
  text) is **not** `--textconv`: it is a different option and is allowed, though it is a prefix of `--textconv`.

`gitRunsOrWritesReason` returns the refusal's message, not a yes or no. A read-only step (`readOnlyShellRefusal`)
refused for one of these git options is given that option's own message (what the option does, and for
`git grep -O` how to rephrase), where any other refusal gets the generic one. A lane gets no message from it:
such a line is simply not settled, and keeps today's judgement.

Two differences from a read-only step's grammar, both for lanes only:

- `ps` is allowed. It prints the process table and has no writing option. It is not added to `READ_COMMANDS`,
  which would also add `Bash(ps:*)` to the read-only steps' allow rules. It is not settled when it may print
  the processes' environment: `-E` in a dash bundle (`-Eww`), or a word with no dash holding an `e` or `E`
  (`ps Eww`, `ps eww`, `ps -x eww`), which ps reads as BSD options. The word check is deliberately broad: it
  also catches an option's value (`-o pid,etime`), and such a call keeps today's judgement. Claude Code's own
  process runs outside the sandbox, so the lane's env denial does not cover it. srt's policy looks like it
  returns no other process's environment (`process-info*` is same-sandbox only, no `kern.procargs` sysctl), but
  that was read, not run, so the guard does not rely on it.
- A glob is plain in an **option's value**: `*`, `?`, `[`, `]` after the `=` of a word that starts with `-`
  (`--include=*.ts`). A match must begin with the literal text before the glob, so it can only be a file named
  `--include=…`, never another option. A glob in any other word (`cat .e*`) stays refused: the shell would fill
  in file names the guard cannot see. A pattern in quotes (`"[v]itest"`) is never a glob.

**Paths.** A settled call must also name no path a lane may never read. Every word that is not a bare option
is judged as a path by the lane's file-access judge (`fileAccess.read('LS', { path })`, the stricter tree
reading). A long option (`--file=/x`) is judged by its value after the `=`. A short option's value may be
attached (`-f/x`, `-nf/x`), and the guard knows no program's options, so every tail of a single-dash word is
judged as a path (`-f/x` gives `f/x` and `/x`); a letter or two read as a relative path is harmless. A
single-dash word over 256 characters is not split and leaves the call to today's judgement. A protected path,
a secret file, a directory that holds protected paths, a path that cannot be resolved, or one starting with
`~` leaves the call to today's judgement. So does any `cd`, after which a relative path means another
directory. So does a path that names a device with no end (`/dev/zero`, `/dev/urandom`, `/dev/random`,
`ENDLESS_FILES` in `guard/background-loops.ts`) or a directory that holds one (`/dev`, and `/` above it),
whichever command reads it and wherever it appears: a foreground read of one (`cat /dev/zero | wc -c`,
`sort /dev/urandom`, `grep -r x /dev`) spins until the Bash timeout, and the endless-loop ask looks only at
background calls. The comparison is on the path as the kernel opens it, not as it is spelled: each word is
resolved from the command's working directory, links followed, and with `..` collapsed as text first, and either
reading counts. That directory is the `cwd` of the PreToolUse hook's request, not the lane's copy: a settled line
has no `cd` of its own, but Claude Code carries a `cd` from an earlier Bash call into the next, so after
`cd apps` the line `cat zero-link` reads `apps/zero-link`. The adapter passes the hook's `cwd` to the guard
(`GuardInput.cwd`), and the same directory is joined to a relative word before the file-access judge sees it
(that judge reads a relative path from the copy's root). A hook `cwd` that is not an absolute path leaves the
call unsettled; with no `cwd` at all (a test double, the fake adapter) the copy's root is used. The hook's `cwd`
is the field `BaseHookInput.cwd` of the SDK's hook input. That Claude Code updates it after a `cd` in an earlier
call is taken from its documented meaning (the session's current directory), not proven live; if it stayed the
start directory, a `cd`-then-read pair would still be judged from the copy's root. So a `../` chain that climbs
to the root and on to `dev/zero`, `/dev/./zero`, a link in the copy that points at `/dev/zero` or at `/dev`, and
a chain of links all stay unsettled. (A relative `dev/./zero` is not among them: it resolves to `dev/zero` inside
the copy, which is not a device. Nor is `../../../../dev/zero` from a copy deeper than four levels: it stops
short of the root and lands on a path that is not a device.) A word with no single real path (`..` past a missing
part, a link loop, a part that cannot be examined) stays unsettled too. `ls /dev` and `ls /` are unsettled as a
result: the guard knows no program's options, so it cannot tell a listing from a recursive read. A path merely
outside the paths a lane may read without asking (`readAsk`) does not leave the call unsettled: see below.

What this does not see: a link met only while a command walks a directory it was given (`grep -R x .` follows a
link inside the copy that points at `/dev/zero`, where `.` itself is no device), and a name the shell would
glob into a device (globs are not settled anyway). The harm is bounded: one core until the Bash timeout.

**Hazards.** A line of read-only commands names no program outside that closed set, so none can be a hazard.
The hazard ask (`hazardHit`, `firstUnread`, `unreadableHazard`) is skipped for it. It had been asking about
`grep -c "[v]itest"` because the scanner took the bracket word for a program it could not read.

An unsandboxed session (no file-access judge) and Monitor are never settled this way.

## Why

On 2026-11-03 the orchestrator approved several "Allow Bash?" cards for `ls -la <the lane's task output dir>;
ps aux | grep -c "[v]itest"` and `grep -rnE … apps/daemon/src --include=*.ts | grep -v … | head -150`. Each
only reads. Two things carded them. The task output directory itself is outside the paths a lane may read
without asking (only files directly in it are allowed), and the hazard ask misread `"[v]itest"`. The
classifier's own escalation also reaches a card no stored rule answers.

**Why it is safe inside the sandbox.**

- The commands cannot write. The set has no writing program, the options that make a reading command write or
  run a program are refused, and a redirection to a file, a substitution and a variable cannot appear, so the
  words the guard reads are the words that run.
- Bash runs under Seatbelt. Its writes are confined to the lane's copy and temp dir, and its reads to the paths
  the lane profile lists. A read outside them fails inside the sandbox whatever the hook or the classifier
  says, which is why a path that is only outside the read list (the task output directory) is not a reason to
  hold the call. A path the lane may never read is refused by name, as the file tools refuse it, and keeps the
  old judgement.
- An allow from a hook skips the permission prompt; it does not lift Seatbelt or Claude Code's deny rules, and
  the guard's refusals run before it.
- What the call gives up is the classifier's second look, including its `hard_deny` for CPU load and the
  full gate. None of these commands can run the gate or a build, and a read-only line is as light as the
  commands it names, except one that names an endless device or a tree holding one by any path that resolves
  to it, which is not settled (above). A device reached only by a link inside a directory the command walks is
  not seen, and costs one core until the Bash timeout. `tail -f` and the like in the background still meet the
  endless-loop ask.

Turned down: adding `ps` to `READ_COMMANDS` (widens the read-only steps' allow rules); judging every glob word by
expanding it (the guard would have to read the file system as the shell will, and the shell can differ);
settling on paths inside the copy only (the first example would still card); an allow list of whole command
lines (the same commands come in endless spellings).

Not proven live: that Claude Code's auto mode honours a hook `allow` before the classifier. The SDK
documents a hook allow as skipping the prompt, and rows g and k of the 2026-10-31 spike showed the hook's
`ask` is honoured in auto mode. The live block ("lane sandbox in auto mode, live") cannot run in a lane; run it
once with a read-only command, and if the classifier still escalates, this decision's hook half needs
revisiting.
