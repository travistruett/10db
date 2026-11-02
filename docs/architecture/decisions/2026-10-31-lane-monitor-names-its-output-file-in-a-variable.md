# A lane's Monitor may name its own output file through a variable

- **Date:** 2026-10-31
- **Superseded by:** `2026-10-31-lanes-run-in-auto-mode-inside-the-sandbox.md`.
- **Amends:** `2026-10-30-lane-monitor-of-its-own-task-output.md`

## Decision

The closed grammar of `inbox/monitor-command.ts` still refuses every expansion, with one exception. A
command may start with plain assignments, `name=<path>` each ended by `;` or a newline, where the value is
one literal word (letters, digits and `_ . / : @ % + , = -`, bare or in one pair of quotes) that
`isOwnFile` accepts. The command is then judged with each word that is exactly `$name` or `"$name"`
replaced by its path, so the grammar and the file check see the same text as before.

Anything else stays as it was: a name not assigned at the start (including one set after its use or in a
loop), `${name}`, a name inside a longer word, with a suffix or in single quotes, a name used as a
redirection target, a command substitution or an expansion in a value, a value `isOwnFile` refuses (any
assignment that fails leaves the whole command judged as written, and so refused), `export`, an
assignment in front of a program, and a command that is only assignments. A name the shell reads itself
(`IFS`, `PATH`, `HOME`, `ENV`, `BASH_ENV`, `PS4`, `LD_*`, `DYLD_*`, zsh's `path`, `fpath`, …, in any case)
is never a name for a file.

## Why

Every Monitor card on 2026-10-30 and 31, one of them after the grammar shipped, had the shape
`f=<own output file>; until grep -qE "…" "$f" 2>/dev/null; do sleep 5; done; grep -E "…" "$f"`. Lanes put
the long path in a variable first.

Writing the paths in, rather than tracking a variable through the shell's rules, keeps the proof the
same: the text judged is the text the shell reads once its names are replaced. The value charset has no
space, glob, tilde or quote, so a path cannot split into two words or expand, and no special name is
accepted, so no assignment changes how a later word is split, found or run (`IFS=<path>` would split
`$f` on its slashes and read a relative file).
