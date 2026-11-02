# numericNames reasons about bash and zsh, and gives up on what it does not know

- **Date:** 2026-11-02
- **Builds on:** `2026-11-01-guard-drops-shell-text-credential-rules.md` (the guard still reads shell text for what it keeps)

## Decision

`guard/numeric-names.ts` reasons about two shells: bash, and zsh, which is the shell a lane's Bash command
actually runs in on macOS (`login-env.ts` defaults `SHELL` to `/bin/zsh`; `shell-words.ts` already reads zsh
syntax). Its list of builtins names both shells' builtins, the builtins of the zsh modules (`zsh/datetime`,
`zsh/stat`, `zsh/system`, `zsh/zutil`, `zsh/pcre`, the completion builtins), and the zsh keywords that set a
name or run a command (`foreach`, `repeat`, `noglob`, `nocorrect`).

A command named by a builtin is understood only when it is on the `UNDERSTOOD` list; any other builtin makes
`numericNames` return no names (`print -v`, `vared`, `zparseopts`, `getln`, `strftime`, `zstat`, `sysread`,
`autoload`, `functions`, `setopt`, `emulate`, `zmodload`, `zle`, `noglob` and the rest). Understood in zsh:
`print` (not with a `v` flag, which stores into a name), `whence`, `where`, `which`, `chdir` (writes `PWD`,
`OLDPWD`), `repeat`, and `integer`, `float` and `private`, read like `declare` (a nameref flag `-n`, or a flag
from an expansion, still gives up). `foreach` sets its variable from a word list the scan does not read, so it
gives up.

The scan looks through `repeat N` and zsh's `-` precommand modifier, in any nesting, to the command they run,
so `repeat 1 print -vs x` and `- vared s` give up like the bare command. `print` and `printf` also give up
when a word the shell expands sits where they still read options (`F=-v; print $F s x`). A word of a
declaring command that is not a `name=value` and that the parser marks dynamic (an unquoted `$`, backtick, glob
character or `~`) may expand to a flag, so `touch ./-n; declare ?n r=s` gives up in `numericNames` and is unread
in `firstUnread`; a quoted `'?n'=1` is not dynamic and stays read. An assignment inside
a parameter expansion counts behind zsh flags and prefix characters (`${(L)s::=x}`, `${=s::=x}`, `${^s:=x}`).
zsh's implicit names are added: `reply` (`read -A`, `-c`, `-l` with no name) and `dirstack` (`cd`, `pushd`,
`popd`). Glob qualifiers that run code (`*(e:…:)`, `*(+fn)`) make the parse uncertain, as any word holding
`(` does today, so the scan gives up; tests pin that.

`expandsIndirectly` also reads zsh's `${(P)name}` (looks up the variable `name` holds), `${(e)name}` (expands
the value again, running substitutions in it) and `${(%)name}` (expands it as a prompt) as indirection, as it
reads `${!name}`: `numericNames` returns no names, and `declaresIntegerAnywhere` (unread-commands.ts) counts a command with such
a word as one that can rebind names. A flag
list is read loosely, so `${(j:e:)x}` counts too; that errs toward asking.

## Why

The allowlist fails closed only if every word that can set a name is on it. It held for bash. A zsh builtin
absent from it was taken for an external program, which cannot set the shell's names, though `print -v s`,
`vared s` or `zparseopts -D -- a=s` do. No concrete path past `firstUnread` was found, but the claim should
hold for the shell the commands run in. A module builtin needs `zmodload` first, and `zmodload` is itself not
understood, so listing the module builtins is a second guard. The cost is that a read-only check using a
builtin outside the list loses its numeric names and asks, as an unknown bash builtin already did.
