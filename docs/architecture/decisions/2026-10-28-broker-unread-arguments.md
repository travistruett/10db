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
  in, a bare shell, a here-string with `$` or a backtick, an unquoted here-document with a substitution; and nesting of `sh -c`,
  `find -exec` or a shell's script deeper than `hazardHit` follows. A script that is plain text is read as
  shell, here-document bodies run by a shell included. A here-document read by any other program is data: its
  substitutions are scanned when the delimiter is unquoted (`<<EOF`), and the body is not read at all when it is
  quoted (`<<'EOF'`, `<<"EOF"`, `<<\EOF`), as in `git commit -m "$(cat <<'EOF' … EOF)"`.
- **Hazard form.** For the known program, the arguments the parser could read are compared with the project's
  hazard commands (and each of them behind `pnpm exec`, `pnpm dlx`, `npm exec`, `npx`, `yarn dlx`). Every
  argument that has an expansion, substitution, glob or tilde is treated as any number of words, unless
  it is fully double-quoted and holds no `$@`, `$*` or `${a[@]}`: that is exactly one word, which may be a
  flag or one word of the hazard command (`pnpm "$x"` could be `pnpm add`; `pnpm --filter "$pkg" test`
  cannot). If the line
  could then start like a hazard command, it is unread: `pnpm $x` could be `pnpm add`, `pnpm exec $x` could be
  `pnpm exec drizzle-kit generate`, `cargo $x` could be `cargo add`, `make $target` could be `make migrate`
  when a project lists it. A word that stands in a flag's value slot counts twice, since it could also add a
  word. `xargs` adds one unread word, since it appends its input. Redirections are dropped before the
  comparison, so `pnpm 2>/dev/null add x`, which `hazardHit` does not see, is a card. The patterns come from the
  hazards passed in, never from a list of programs.
- **Flags and runners.** `hazardHit` and this scan read a command's plain words the same way
  (`apps/daemon/src/guard/command-forms.ts`). For `npm`, `pnpm`, `yarn`, `cargo` and `git` the value-taking flags
  are listed per program (`pnpm --reporter silent add x`, `git -C dir add x`), `cargo +toolchain` is skipped,
  and a flag in neither the value nor the boolean list, followed by a word, is read both ways (`npm -p install x`
  is `npm install x`, or `npm x`), so either reading can be a hazard. Other programs keep one shared list of
  value flags. `mise x --` and `mise exec --`, `corepack pnpm` (and `npm`, `npx`, `yarn`), `arch -<arch>` and
  `script -q /dev/null` are looked through like `env` and `nice`: the command they run is the one matched.

An unread argument to a program that has no hazard form is allowed: `cd $d`, `eslint $f`, `grep "$x"`, `make
test` when no hazard names `make`. So is `pnpm test $x`, whose first word cannot become a hazard's, and
`pnpm --filter "$pkg" test`, where the quoted value fills the flag's slot.

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
- `trap` and `hash` are unread, with the other opaque programs, as is `.` or `source` of a stream or with input redirected in, and any word with
  an array subscript that holds `$(` or a backtick (`read`, `[[ -v ]]`, `printf -v`).
- A `-c` script that reads as an option, `.` or `source` of anything but a plain file path (a stream, `/dev` or
  `/proc` once the path is normalized, any expansion including `~`, or input piped or redirected in; an absolute
  path outside `/dev` and `/proc` is read), more than one `xargs`
  wrapper, and the arithmetic uses below are unread.
- `.` and `source` read a file only when it is a plain path with no option but `--`, no input redirected or
  piped in (including through an enclosing `sh -c`), and, if relative, no earlier `cd`, `pushd` or `popd` in the
  script. The `-eq`-style operators of `[[` (not `[` or `test`, which compare integers as text), the name after `-v`, `let`, `read`, `unset` (redirections aside), `printf -v` and a
  declaration (`declare -i` any word, otherwise the name) with a parameter expansion or backtick are unread, since
  the shell evaluates a variable's value as arithmetic there.
- A transform other than `Q`, `U`, `u`, `L` or `a` (`${x@P}` expands a prompt, which runs substitutions) is unread,
  and so is an option word with an expansion on a declaring builtin (`declare -$f x`). `$#`, `$?`, `$$`, `$!` and
  `${#name}` count as numbers.
- Any word of any segment, an assignment alone included, with a `$` or backtick inside `[…]`, `$[…]`,
  `${…[…]}`, `${…:offset…}` or `$((…))` is unread, and so is any `$` or backtick in the words of `let`,
  `read`, `unset`, `getopts` and `printf -v`, and in the option words and names of `declare`, `typeset`,
  `local`, `export` and `readonly`. The value of a plain scalar assignment there (`export NAME=$value`,
  `local dir=$1`) is stored as written and is allowed, as in bash 3.2 and zsh, unless the command has an array
  option (`-a`, `-A`: bash may read the value as a compound assignment). Over-flagging is accepted: a card is
  the safe default.
- Arithmetic is read only when it is numeric (`apps/daemon/src/guard/arithmetic-words.ts`): bash evaluates a bare
  name there as the variable it names, and its value again, so a name is as unread as `$n`. An arithmetic
  expansion, `$[…]`, a subscript on an assigned or expanded name (`@` and `*` aside), a `${a:off:len}` offset, the
  operands of `let` and of a test's `-eq`-style operators, the name after `-v`, and the values given to
  `declare -i` are unread unless every operand is a number or an operator. Every subscript and offset in a `${…}` is checked, whatever the prefix. A script that declares an integer attribute anywhere (`declare`, `typeset`, `local`, `export`, `readonly` with `-i`, or `integer`, through runners, nested scripts and substitutions) is unread as a whole, and so is one that declares a nameref (`-n`) or expands a variable by another's name (`${!name}`; the name-listing forms `${!prefix*}`, `${!prefix@}` and `${!a[@]}` are read).
- The shell keywords the scan skips (`for`, `select`, `done`, `fi`, `esac`) are judged on the word as written, so
  `./done` and `$D/fi` are programs.

Known gaps, deliberately left for follow-ups. The sandbox bounds all of them; none is a new capability:

- **Runners.** A hazard behind a runner the scan does not look through: `git rebase --exec`,
  `git -c alias.x='!…'`, `GIT_PAGER=… git -p log`, `mise x -c 'cmd'` and `mise x tool cmd` with no `--`, a symlinked
  binary. Linux's `script -c 'cmd'` is not looked through either.
- **Flag values.** A program with no table in `command-forms.ts` shares one list of value flags. An unquoted
  expansion in a flag's value slot (`pnpm --filter $pkg test`, `--filter=$pkg`) still counts as any number of
  words, since it may split.
- **Arithmetic on names.** `n=$((n+1))`, `${arr[$i]}` and `[[ $n -gt 3 ]]` stay cards, and so do `trap '…' EXIT` and
  `source ~/…`.
- **Directory changes** inside a substitution or subshell are not tracked for `.` and `source`; only a `cd`,
  `pushd` or `popd` that starts a segment of the script is.
- **An integer attribute inherited from outside the command**, such as an exported integer variable: a plain
  assignment to one is not flagged.
- **Here-document bodies** read by a program that is not a shell skip the arithmetic and transform checks (`$((n))`,
  `${a[n]}`, `${a:$n}`, `${x@P}`); their substitutions, integer declarations and indirect expansions are scanned,
  and a quoted body is not read at all.
- **Prompt variables** (`PS0`, `PS1`, `PS2`, `PS4`, `PROMPT_COMMAND`) assigned in a script that also turns on tracing
  (`set -x`, `bash -x`) are not flagged.
- **Review findings L1 and L3**, minor, recorded in PR #95.

The scan is a filter that decides when a card can be skipped, not a security boundary: anything it misses still
runs inside the lane sandbox.

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
