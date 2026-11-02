# The guard no longer reads shell text for credentials

- **Date:** 2026-11-01
- **Amends:** decision 124 (the sandbox is always on); builds D12 of `../../superpowers/specs/2026-10-25-10db-lane-sandbox-design.md`

## Decision

`guard/judge.ts` no longer refuses a Bash or Monitor command for Keychain commands (`security`, AppleScript
naming the Keychain), environment dumps (`env`, `printenv`, `export`, `ps` with the environment, `${!name}`),
references to a secret variable, or a protected path named in its text (including through `$HOME`, `~`,
globs, braces, a `cd`, or a recursive reader). The kernel sandbox decides what a lane's command can read.

What the guard keeps: claims, commits only through `commit`, the delivery and `gh` rules, hazard routing, the
`rm -r`, `sudo`, deploy and unread-word rules, read-only steps, and the structured path checks on the file
tools (`pathRefusal` and `isOwnToolResult` in `account-rules.ts`, which resolve a path through links and `..`
and apply to Read, Grep, Glob, LS and the edit tools). The broker is unchanged: it never held a credential
text rule.

The directory tracking that only fed the path rule (the directories a segment may run in, subshell numbers,
`!` negation) is deleted. `rm -r` still refuses after a `cd`, which needs only whether the shell may have
changed directory.

## Why

Text rules cannot hold against bash and zsh, and each round of fixes produced new false denies and cards
(threat model §9). The sandbox denies the Keychain, the account directories, the data directory and every
credential variable by name, whatever the shell text says. Every real lane and gate runs under it with no
switch, so the text rules guarded only what the kernel already refuses. A repository without the
sandbox can no longer start a lane (the adapter refuses an unsandboxed spec outside tests), so no path
depends on them.
