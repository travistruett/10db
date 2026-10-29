# The broker asks about a sandboxed command only when something unread could hide a hazard

- **Date:** 2026-10-28
- **Amends:** decision 92

## Decision

Decision 92 stands: `autoAllowBashIfSandboxed` stays off, every Bash call reaches the broker, and the broker
allows a sandboxed call without a card unless it is a hazard command or a dependency change. What changes is
which commands count as unreadable. The broker used to ask whenever the shell parser was not certain of the
whole line, and not at all about words it could not read. It now asks when `hazardHit` finds a hazard, when
`req.escalated`, or when `firstUnread` (`apps/daemon/src/guard/unread-commands.ts`) finds something unread that
could hide one:

- **Structure.** The parser is not sure where commands begin and end: an open quote, parenthesis or
  substitution, a case, a function definition, arithmetic, a group brace in the middle of a command, a zsh
  clobber redirection, an ANSI-C escape it cannot decode.
- **Process substitution.** `<(…)` and `>(…)` hand a command's input or output to another command.
- **Program name.** Every simple command, in the line and in its substitutions, must name its program in plain
  text, after `env`, `exec`, `command`, `nohup`, `time`, `xargs`, `nice`, `timeout`, `stdbuf` and assignments
  are looked through. An expansion, substitution, backtick, glob or tilde in the name or its directory, an
  `env -S`, a redirection among a wrapper's words, and the programs that run or define a command 10db does
  not look through (`sudo`, `doas`, `su`, `noglob`, `nocorrect`, `coproc`, `repeat`, `foreach`, `function`,
  `alias`) are unread.
- **Script.** `eval`; a shell (`sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`, `csh`, `tcsh`) run with `-c` and no
  script, a script that holds `$` or a backtick (the outer shell may fill it in), a script piped or redirected
  in, a bare shell, a here-document or here-string body with `$` or a backtick; and nesting of `sh -c`,
  `find -exec` or a shell's script deeper than `hazardHit` follows. A script that is plain text is read as
  shell, here-document bodies run by a shell included. A here-document read by any other program is data.
- **Hazard form.** For the known program, the arguments the parser could read are compared with the project's
  hazard commands (and each of them behind `pnpm exec`, `pnpm dlx`, `npm exec`, `npx`, `yarn dlx`). Every
  argument that has an expansion, substitution, glob or tilde is treated as any number of words. If the line
  could then start like a hazard command, it is unread: `pnpm $x` could be `pnpm add`, `pnpm exec $x` could be
  `pnpm exec drizzle-kit generate`, `cargo $x` could be `cargo add`, `make $target` could be `make migrate`
  when a project lists it. A word that stands in a flag's value slot counts twice, since it could also add a
  word. `xargs` adds one unread word, since it appends its input. Redirections are dropped before the
  comparison, so `pnpm 2>/dev/null add x`, which `hazardHit` does not see, is a card. The patterns come from the
  hazards passed in, never from a list of programs.

An unread argument to a program that has no hazard form is allowed: `cd $d`, `eslint $f`, `grep "$x"`, `make
test` when no hazard names `make`. So is `pnpm test $x`, whose first word cannot become a hazard's.

The parser also reads a parenthesis after `do`, `then`, `else`, `elif`, `if`, `while`, `until` or `!` as a
subshell, as it already read one after `&&`. It used to call it uncertain, so every `for … do (cd $d && …);
done` earned a card. This changes the guard's `certain` flag too, which only ever made it more careful.

`hazardHit`, the git guard and `autoAllowBashIfSandboxed` are unchanged. The sandbox, not this scan, bounds what
a program does: a script, `node -e` or `make` target that runs a hazard inside it is outside this rule, as it
was before.

## What the scan covers, and its known gaps

The scan reads the command's text with these rules, and nothing more:

- A shell's `-c` script is the first operand after `-c`, once options (`-e`, `-o x`, `+O x`, `--`) are skipped.
  Every here-string (`<<<`, on any descriptor) is a script.
- Under `xargs -I`, `-i`, `-J` or `--replace`, every argument is unread, and the replace string in the program or
  in a shell's script is unread. An `xargs` long flag the scan does not know is an unread program name.
- `trap` and `hash` are unread, as is `.` or `source` of a stream or with input redirected in, and any word with
  an array subscript that holds `$(` or a backtick (`read`, `[[ -v ]]`, `printf -v`).
- A `-c` script that reads as an option, `.` or `source` of anything but a checkout file (a stream, `/dev` or
  `/proc` once the path is normalized, an expansion, or input piped or redirected in), more than one `xargs`
  wrapper, and a substitution in any word of an arithmetic-evaluating builtin (`[[`, `test`, `let`, `read`,
  `printf`, `declare`) are unread.
- `.` and `source` read a file only when it is a plain path with no option but `--`, no input redirected or
  piped in (including through an enclosing `sh -c`), and, if relative, no earlier `cd`, `pushd` or `popd` in the
  script. A test operator that evaluates its operands (`-eq`, `-v`), `let`, `read`, `unset`, `printf -v` and a
  declaration (`declare -i` any word, otherwise the name) with a parameter expansion or backtick are unread, since
  the shell evaluates a variable's value as arithmetic there.
- Any word of any segment, an assignment alone included, with a `$` or backtick inside `[…]`, `$[…]`,
  `${…[…]}`, `${…:offset…}` or `$((…))` is unread, and so is any `$` or backtick in the words of `declare`,
  `typeset`, `local`, `export`, `readonly`, `let`, `read`, `unset`, `getopts` and `printf -v`. Over-flagging is
  accepted: a card is the safe default.
- Arithmetic is read only when it is numeric (`apps/daemon/src/guard/arithmetic-words.ts`): bash evaluates a bare
  name there as the variable it names, and its value again, so a name is as unread as `$n`. An arithmetic
  expansion, `$[…]`, a subscript on an assigned or expanded name (`@` and `*` aside), a `${a:off:len}` offset, the
  operands of `let` and of a test's `-eq`-style operators, the name after `-v`, and the values given to
  `declare -i` are unread unless every operand is a number or an operator. After a `declare -i`, `typeset -i` or
  `integer` in a script, a later assignment whose value is not a number is unread. `[ "$#" -eq 0 ]` therefore earns
  a card.
- The shell keywords the scan skips (`for`, `select`, `done`, `fi`, `esac`) are judged on the word as written, so
  `./done` and `$D/fi` are programs.

Known gaps, deliberately left for follow-ups. The sandbox bounds all of them; none is a new capability:

- **Runners.** A hazard behind a runner the scan does not look through: `arch -arm64 pnpm add x`,
  `script -q /dev/null pnpm add x`, `mise x -- pnpm add x`, `corepack pnpm add x`, `git rebase --exec`,
  `git -c alias.x='!…'`, `GIT_PAGER=… git -p log`, a symlinked binary.
- **Per-program flag values.** Flags that take a value, in `apps/daemon/src/guard/command-forms.ts`: `npm -p
install x`, `pnpm --reporter silent add x`, `cargo +stable add serde`.
- **Directory changes** inside a substitution or subshell are not tracked for `.` and `source`; only a `cd`,
  `pushd` or `popd` that starts a segment of the script is.
- **Integer variables the scan did not see declared** (`declare -i` in another command, an inherited attribute):
  a plain assignment to one is not flagged.
- **Review findings L1 and L3**, minor, recorded in PR #95.

## Why

A real task ran `for d in …; do (cd $d && pnpm exec tsc --noEmit …); done; pnpm exec eslint … | grep -v …` and
got a card, though it runs only `cd`, `pnpm exec tsc`, `grep` and `pnpm exec eslint`. The cause was the parser
calling a `(` after `do` uncertain, not the `$d`. In the other direction the old rule let an unread program
name or subcommand through: the parser keeps `$CMD`, `$(echo pnpm)` or `pnpm $x` as plain words and is
"certain" of them, so `$CMD add left-pad` ran with no card. Decision 92 promised a card for hazards; a hazard
spelled with a variable is still a hazard.

Asking about every command with an unread word would bring back a card for most loops and variables, which
decision 92 removed. Asking about none would defeat it. The line is where the unread word could change what
the line is judged to be: its program, a script it runs, or a word that could complete a hazard command.
Aliases defined outside the command, functions the shell already knows, and interpreters that run code from a
string (`node -e`, `python -c`) cannot be seen from the text, and are covered by the sandbox as before.

Turned down: allowing a process substitution whose bodies read clean (it forwards output to a command no scan
follows); matching hazards on program names alone (a custom hazard's program would be missed); one card
reason per unread word (the builder sees the command either way).
