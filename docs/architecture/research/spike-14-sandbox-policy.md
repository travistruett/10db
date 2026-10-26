# Spike 14: the lane sandbox's read policy, links, temp directory and cards

- **Status:** Checks 5, 9, 10 and 12 are VERIFIED. A session gets its own Bash temp directory only through a
  `CLAUDE_CODE_TMPDIR` of 44 bytes or less. Check 11 is PARTIAL: no setting made the sandbox unavailable on macOS,
  and the run found an invalid sandbox setting that turns the sandbox off without an error.
- **Date:** 2026-10-26
- **Versions:** claude 2.1.310 (Claude Code) · Agent SDK 0.3.300 · Node v26.12.0 · pnpm 12.13.0 · mise 2026.10.11
- **Command:** `pnpm --dir spikes/agent-sdk spike:14 <policy | links | tmp | unavailable | deps>`
- **Threat model:** `../03-trust-boundaries.md` §8 checks 5, 9, 10, 11 and 12. The design they test is
  `../../superpowers/specs/2026-10-25-10db-lane-sandbox-design.md` (D1–D3, D8, D14).

Every session ran on `haiku` at effort `low`, billed to the subscription, with `maxBudgetUsd: 0.5`. The whole
spike cost under $0.10. A `PreToolUse` hook let Bash run only the listed commands, and refused any file-tool path
that names a real credential location. Haiku ran every listed step verbatim.

Each content check reads a canary: a file holding a random token, made for the run and removed afterwards. The
canaries sit in nine places:

| Canary      | Where                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| `home`      | `~/.10db-s14-canary-<run>/`                                                         |
| `sibling`   | a second repository beside the lane's checkout, `~/.10db-s14-projects-<run>/other/` |
| `shared`    | `/Users/Shared/.10db-s14-canary-<run>/`                                             |
| `otherTmp`  | another lane's temp directory, `/private/tmp/10db-<run>-b/`                         |
| `claudeTmp` | Claude Code's shared temp directory, `/private/tmp/claude-<uid>/`                   |
| `systemTmp` | `/private/tmp/`                                                                     |
| `volume`    | a 4 MB disk image the run mounts at `/Volumes/10db-s14-<run>`                       |
| `envFile`   | `.env.local` in the lane's checkout                                                 |
| `linked`    | in the home canary directory, reached through links in the checkout (check 12)      |

The lane's checkout is a git repository under home, `~/.10db-s14-projects-<run>/lane`, where the builder's
projects live. Nothing touches the Keychain, and no real credential file is read.

Every profile starts from the lane base:

```json
{
  "enabled": true,
  "failIfUnavailable": true,
  "allowUnsandboxedCommands": false,
  "allowAppleEvents": false,
  "autoAllowBashIfSandboxed": false
}
```

The protected reads are in every `denyRead`: `~/.claude`, `~/.claude.json`, `~/Library/Keychains`,
`~/Library/Application Support/10db` and `/usr/bin/security`.

## Summary

| #   | Check                                            | Result   | Evidence (in `spikes/agent-sdk/out/`)                        |
| --- | ------------------------------------------------ | -------- | ------------------------------------------------------------ |
| 5   | `allowRead` under a denied root; deny `/`        | VERIFIED | `14-run-policy*.txt`, `14-policy-*.json`                     |
| 12  | Read deny rules and links; Grep and Glob         | VERIFIED | `14-run-links.txt`, `14-links-*.json`                        |
| 10  | A temp directory per session                     | VERIFIED | `14-run-tmp.txt`, `14-tmp-*.json`, `14-run-policy-lane.txt`  |
| 11  | How a sandbox that can't start is reported       | PARTIAL  | `14-unavailable-*.json`, `14-unavailable-bad-mask.debug.log` |
| 9   | A real `pnpm add <package>` reaches `canUseTool` | VERIFIED | `14-run-deps.txt`, `14-deps-*.json`                          |

## 5. The read policy (`policy`): VERIFIED

### Question

Does a narrower `allowRead` reopen a child of a denied root in `Options.sandbox`? Does the stronger form work:
deny `/` and allow the system paths back? What must be allowed again for git, node, pnpm and mise?

### Result

Each variant ran the same 16 commands: a `cat` of each canary, then reads in the checkout, git, node, pnpm,
mise, a write to `$TMPDIR` and a write in the checkout.

| Variant                  | `denyRead` (plus the protected reads and `.env.local`)                                        | Canaries read                                            | Tools                                        |
| ------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| control                  | the protected reads only, no `.env.local`                                                     | every canary but `linked`                                | all work                                     |
| deny home                | `~`                                                                                           | `shared`, `otherTmp`, `claudeTmp`, `systemTmp`, `volume` | git fails: it can't read `~/.gitconfig`      |
| deny the user-data roots | `/Users`, `/Volumes`, `/private/tmp`, `/private/var/folders`                                  | none                                                     | git fails as above; writes to `$TMPDIR` fail |
| deny the roots, fixed    | the same, with `/private/tmp/claude-<uid>` allowed again and `GIT_CONFIG_GLOBAL=/dev/null`    | `claudeTmp` only                                         | all work                                     |
| deny `/`, final          | `/`, with the system paths allowed again (below)                                              | `claudeTmp` only                                         | all work                                     |
| the lane profile         | the deny-`/` form, with the lane's own temp directory in place of `/private/tmp/claude-<uid>` | none                                                     | all work                                     |

- **`allowRead` reopens a child of a denied root.** VERIFIED. Under every deny form, `cat README.md` in the
  checkout worked, and so did git, node and pnpm, once the checkout and the toolchain directories were in
  `allowRead`.
- **A `denyRead` inside an `allowRead` still holds.** VERIFIED for one exact path. `cat .env.local` failed with
  `Operation not permitted` in every deny variant, though the checkout around it was allowed. The run listed the
  file by its exact path. Whether `denyRead` takes a glob such as `<checkout>/**/.env*` is UNKNOWN.
- **Denying home alone leaves user data open.** VERIFIED. `/Users/Shared`, both temp roots and the mounted
  volume stayed readable, which is the gap ChatGPT's review named.
- **Deny `/` works.** VERIFIED. The working list, beyond the checkout and the protected reads:
  - **System paths:** `/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/private/etc`, `/private/var/db`,
    `/private/var/run`, `/private/var/select`, `/dev`, `/opt/homebrew`, `/Applications/Xcode.app`.
  - **The root links:** `/tmp`, `/var` and `/etc` are links into `/private`. A path through one fails until the
    link itself is readable: with `/tmp` denied, every command failed with `zsh: operation not permitted:
/tmp/claude-<uid>/cwd-…`, and git failed because xcode-select couldn't read `/var/select/developer_dir`.
    Allowing `/tmp` reopened only the link: the `systemTmp` canary in `/private/tmp` stayed unreadable.
  - **The lane's temp directory:** the directory `CLAUDE_CODE_TMPDIR` names (check 10). Without it, Claude Code's
    shared `/private/tmp/claude-<uid>` has to be allowed instead, and every lane can then read it.
  - **Toolchains:** `~/.local/share/mise`, `~/.config/mise`, `~/.local/state/mise`, `~/.cache/mise`,
    `~/Library/pnpm`, `~/Library/Caches/pnpm` and `~/Library/Preferences/pnpm`. These were enough for node, pnpm
    and mise. No entry was removed one at a time to show it is needed.
- **Git needs one change.** VERIFIED. With home denied, git stops at `fatal: unable to access '~/.gitconfig':
Operation not permitted`. `GIT_CONFIG_GLOBAL=/dev/null` fixes it, and keeps the builder's global config out of
  the lane. Two warnings remain on stderr and change no result: `/usr/bin/git`'s xcrun shim can't write its
  cache under `/private/var/folders`, and git can't read `~/.config/git/ignore`.
- **mise tries the network.** `mise ls` retried `mise.jdx.dev` three times and then printed its result. Nothing
  else reached for a host.
- **Not run here:** cargo, and the 10db gate under this profile (check 15).

### Evidence

```
INFO policy-control: canaries readable with no user-data deny: ["home","sibling","shared","otherTmp","claudeTmp","systemTmp","volume","envFile"]
FAIL policy-deny-home: no canary outside the checkout leaked: LEAKED shared,otherTmp,claudeTmp,systemTmp,volume
PASS policy-deny-roots: no canary outside the checkout leaked: none
INFO policy-deny-home: tool git status: fatal: unable to access '~/.gitconfig': Operation not permitted
PASS policy-deny-slash-final: the checkout reads (allowRead reopens it): # s14 lane
INFO probe policy-deny-slash-final done: {"leakedAnywhere":["claudeTmp"]}
PASS policy-lane-profile: no canary outside the checkout leaked: none
INFO policy-lane-profile: tool pnpm --version && pnpm run hello: 12.13.0 ⏎ hello-from-pnpm
INFO policy-lane-profile: tool echo "TMPDIR=$TMPDIR" && touch "$TMPDIR/…": TMPDIR=/private/tmp/10db-1cfa65ac-a/claude-501 ⏎ tmp-write-ok
CALL cat .env.local → Exit code 1 ⏎ cat: .env.local: Operation not permitted
```

## 12. Read deny rules and links (`links`): VERIFIED

### Question

Does a `Read(...)` deny rule hold when the Read tool reads a link inside the working directory that points at a
denied file? Do Grep and Glob follow links out of it?

### Result

The checkout held `link-file.txt`, a link to the `linked` canary, and `link-dir`, a link to the home canary
directory. Seven file-tool steps ran in each of four variants: Read of `link-file.txt`, of `link-dir/linked.txt` and
of the canary by its real path with the directory name in upper case; Grep for the token from the checkout root and
from `link-dir`; Glob for `link-dir/*` and `**/linked*`.

| Variant                                                               | Read through a link    | Read, case changed   | Grep from `link-dir` | Grep from the root, Glob |
| --------------------------------------------------------------------- | ---------------------- | -------------------- | -------------------- | ------------------------ |
| bare `Read`, `Grep`, `Glob` allow rules, no deny rule (today's shape) | leaks, no `canUseTool` | leaks                | leaks both canaries  | finds nothing            |
| bare allow rules and `Read(//<canary dir>/**)` deny rule              | denied                 | denied               | denied               | finds nothing            |
| `Read(//<checkout>/**)` allow rule and the deny rule                  | denied                 | denied               | denied               | finds nothing            |
| `Read(//<checkout>/**)` allow rule, no deny rule                      | reaches `canUseTool`   | reaches `canUseTool` | reaches `canUseTool` | finds nothing            |

- **Claude Code resolves links before its rules apply.** VERIFIED for 2.1.310. A deny rule on the target
  directory stopped a read through a file link and through a directory link (`Permission to read
<checkout>/link-file.txt has been denied.`). With only a checkout-scoped allow rule, the read reached
  `canUseTool` with the reason `<checkout>/link-file.txt resolves through a symlink to ~/.10db-s14-canary-…/linked.txt,
which is outside the allowed working directories`. The checkout's allow rule did not cover the link.
- **Rules match case-insensitively.** VERIFIED. The upper-case spelling of the canary path was refused by the
  deny rule (`File is in a directory that is denied by your permission settings.`), and with no deny rule it
  reached `canUseTool` as outside the working directories.
- **Grep follows a link only when its `path` is the link.** VERIFIED. From the checkout root, Grep found nothing:
  ripgrep doesn't follow links by default. With `path` set to `link-dir`, Grep read both files behind it under
  the bare allow rule, and was denied or asked under the others.
- **Glob doesn't follow a directory link.** VERIFIED. `link-dir/*` and `**/linked*` found nothing in every
  variant.
- **Today's bare allow rules leak through a link.** VERIFIED (the first row). A lane's Bash can make a link to any
  file without reading it, and the Read tool then reads it with no card.
- **What this means for D8.** For a read through a link, `canUseTool` gets the resolved target in `blockedPath`
  (`~/.10db-s14-canary-…/linked.txt`, and the directory for Grep). For the direct upper-case path, `blockedPath`
  was empty. 10db still resolves every path itself, as D8 says. The guard's resolved-path check is the second
  layer: Claude Code's own resolution holds in this version, and 10db does not rely on it alone.

### Evidence

```
CALL Read {"file_path":"<checkout>/link-file.txt"} [bare allow] → 1	«canary:linked»
CALL Grep {"pattern":"s14x","path":"<checkout>/link-dir"} [bare allow] → link-dir/linked.txt:1:«canary:linked» ⏎ link-dir/secret.txt:1:«canary:home»
CALL Read {"file_path":"<checkout>/link-file.txt"} [deny rule] → Permission to read <checkout>/link-file.txt has been denied.
CALL Read {"file_path":"~/.10DB-S14-CANARY-…/linked.txt"} [deny rule] → File is in a directory that is denied by your permission settings.
ASKED Read {"file_path":"<checkout>/link-file.txt"} reason=<checkout>/link-file.txt resolves through a symlink to ~/.10db-s14-canary-…/linked.txt, which is outside the allowed working directories
```

## 10. A temp directory per session (`tmp`): VERIFIED, with a length limit

### Question

Can each session's sandbox get its own temp directory instead of the shared `/tmp/claude-<uid>`?

### Result

- **`CLAUDE_CODE_TMPDIR` moves Bash's `TMPDIR`, if the path is short.** VERIFIED. With `CLAUDE_CODE_TMPDIR` set
  to `/private/tmp/10db-<run>-a` in the session environment, Bash's `TMPDIR` was
  `/private/tmp/10db-<run>-a/claude-<uid>`, and writes there worked.
- **A path over 44 bytes falls back to the shared directory without a word.** VERIFIED. The first runs used a
  directory under `/private/var/folders/…/T/`, about 70 bytes. Claude Code then made `<dir>/claude-<uid>` for its
  own files, but Bash's `TMPDIR` stayed `/tmp/claude-<uid>`. The 2.1.310 bundle chooses the sandbox's temp root
  with `Buffer.byteLength(dir) <= 44 ? dir : "/tmp"`, which keeps unix socket paths under macOS's limit.
  `CLAUDE_TMPDIR` and `TMPDIR` in the session environment change nothing.
- **The shared directory closes.** VERIFIED. With a short `CLAUDE_CODE_TMPDIR`, a write to
  `/private/tmp/claude-<uid>` was refused (`Operation not permitted`) with no other setting. With the temp roots
  (`/private/tmp`, `/private/var/folders`) in `denyRead` and the lane's directory in `allowRead`, the `otherTmp`
  canary in another lane's directory and the `claudeTmp` canary in the shared one were unreadable, and a write into
  the other lane's directory was refused.
- **Without it, the shared directory must stay open.** VERIFIED. When Bash's `TMPDIR` is `/tmp/claude-<uid>`,
  `denyWrite` on it fails every command (the Bash tool writes `cwd-<id>` there after each one), and denying reads
  of it stops tools reading back their own temp files. Every lane then reads every other lane's files.
- **The whole lane profile runs with it.** VERIFIED in check 5 (`policy-lane-profile`): deny `/`, the lane's own
  temp directory, and no shared temp root. No canary leaked, and git, node, pnpm and mise worked.
- **`mktemp` with no template ignored `TMPDIR`.** It tried `/private/var/folders/…/T/` and was refused, in every
  variant. Why is UNKNOWN; `mktemp "$TMPDIR/x.XXXXXX"` is the shape that works.
- **A `CLAUDE_CODE_TMPDIR` that is not a directory stops the session before `init`** (check 11).

So D14 can be built for lanes: 10db makes a directory with a short path per session, sets `CLAUDE_CODE_TMPDIR`
to it, allows it in the profile, and checks the length before the session starts.

### Evidence

```
CALL echo "TMPDIR=$TMPDIR" [CLAUDE_CODE_TMPDIR under /private/var/folders, ~70 bytes] → TMPDIR=/tmp/claude-501
CALL echo "TMPDIR=$TMPDIR" [CLAUDE_CODE_TMPDIR=/private/tmp/10db-70447a6e-a] → TMPDIR=/private/tmp/10db-70447a6e-a/claude-501
CALL touch '/private/tmp/claude-501/s14-shared-…' [short CLAUDE_CODE_TMPDIR] → touch: …: Operation not permitted
CALL cat '/private/tmp/10db-70447a6e-b/secret.txt' [short CLAUDE_CODE_TMPDIR, temp roots denied] → cat: …: Operation not permitted
CALL echo "TMPDIR=$TMPDIR" [CLAUDE_CODE_TMPDIR unset, denyWrite /private/tmp/claude-501] → zsh:1: operation not permitted: /tmp/claude-501/cwd-6ce2
```

## 11. A sandbox that can't start (`unavailable`): PARTIAL

### Question

How does the SDK report a sandbox that `failIfUnavailable` stops: an init error, or a failure at the first Bash
call?

### Result

- **No setting made the sandbox unavailable on macOS.** VERIFIED for what was tried. `/usr/bin/sandbox-exec` is
  always present. A missing `ripgrep.command`, a malformed allowed domain (`https://bad/url:x`) and a relative
  `allowUnixSockets` path all ran sandboxed: the debug log shows `Applied restrictions` and the canary stayed
  denied. The code path for a sandbox lost mid-session refuses the command with "Sandbox is required
  (sandbox.failIfUnavailable) and stopped being available in this session" (read from the 2.1.310 bundle, not
  run). How a sandbox that never starts is reported stays UNKNOWN.
- **A startup refusal arrives as a process exit.** VERIFIED. With `CLAUDE_CODE_TMPDIR` set to a file, no `init`
  arrived and the query threw `Claude Code process exited with code 1. stderr: Error processing settings:
ENOTDIR: not a directory, mkdir '<file>/claude-501'`. A card can quote that text.
- **An invalid sandbox setting turns the sandbox off without an error.** VERIFIED, and not in the design. A
  `credentials.envVars` entry whose `extract` is not a valid regular expression made Claude Code skip the
  sandbox block it got from the SDK. The debug log says `Invalid setting skipped without dialog (automated
session): --settings (inline JSON): sandbox.credentials.envVars.0.extract: ... is not a valid regular
expression`. The session started normally, Bash ran with no sandbox, and the canary in `denyRead` was read.
  stderr had no line about it, and `failIfUnavailable: true` didn't stop it. The SDK passes `Options.sandbox`
  through `--settings`, so any value that fails Claude Code's settings schema would probably do the same. Only
  this one was tried.
- **What this means for D1.** 10db can't learn from the SDK that its sandbox was dropped. The lane profile must
  be one Claude Code accepts: 10db builds it from paths, host names and variable names only, never a pattern,
  and checks it against a strict schema before the session starts. A live test runs the exact profile 10db builds
  and asserts that a canary in `denyRead` stays unreadable.

### Evidence

```
INFO unavailable-ripgrep: outcome: {"leaked":[],"subtype":"success"} ⏎ [Sandbox macOS] Applied restrictions - network: true, read: denyAllExcept, write: denyAllExcept
INFO unavailable-bad-mask: outcome: {"leaked":["home"],"subtype":"success"} ⏎ stderr: none
14-unavailable-bad-mask.debug.log: [ERROR] Invalid setting skipped without dialog (automated session): --settings (inline JSON): sandbox.credentials.envVars.0.extract: [REDACTED] is not a valid regular expression
INFO unavailable-tmpdir-file: outcome: {"sawInit":false,"error":"Claude Code process exited with code 1. stderr: Error processing settings: ENOTDIR: not a directory, mkdir '…/not-a-dir/claude-501'"}
```

## 9. A dependency change reaches `canUseTool` (`deps`): VERIFIED

### Question

With `autoAllowBashIfSandboxed: false`, does a real `pnpm add <package>` reach `canUseTool`? Do `ask` rules and
hooks that return `ask` reach it with the sandbox on?

### Result

A throwaway project in the temp directory, with `registry.npmjs.org` in `allowedDomains`:

| Variant                                                                 | `pnpm add is-number@7.0.0` | `npm install is-odd@3.0.1` | `pnpm remove is-number` | `git status` |
| ----------------------------------------------------------------------- | -------------------------- | -------------------------- | ----------------------- | ------------ |
| auto-allow off                                                          | `canUseTool`               | `canUseTool`               | `canUseTool`            | not asked    |
| auto-allow on, hook returns `ask` for adds                              | `canUseTool`               | `canUseTool`               | not asked               | not asked    |
| auto-allow on, `ask` rules `Bash(pnpm add:*)` and `Bash(npm install:*)` | `canUseTool`               | `canUseTool`               | not asked               | not asked    |

- **D3's mechanism holds.** VERIFIED. With auto-allow off, each dependency command arrived with the reason
  `This command requires approval`. A hook's `ask` and an `ask` rule also bring a command to `canUseTool` under
  auto-allow, so either is a fallback. The broker still has to tell a hazard from an ordinary command: every
  non-read-only command arrives the same way.
- **An approved install fails with the shared caches.** VERIFIED. With default config, pnpm failed with
  `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK … Failed to open the store operation lock at "pnpm-store-operation-locks":
Operation not permitted`, and npm with `EPERM` on `~/.npm/_cacache`. Both write shared caches outside the
  checkout. No `SandboxNetworkAccess` request was made: the registry was listed.
- **npm works with its cache in the checkout.** VERIFIED. With `npm_config_cache=<checkout>/.pkg-cache/npm`,
  `npm install is-even@1.0.0` added its five packages inside the sandbox.
- **pnpm 12 still fails with every directory in the checkout.** VERIFIED. `pnpm_config_store_dir`,
  `pnpm_config_state_dir` and `pnpm_config_cache_dir` point pnpm into the checkout (`pnpm config get` shows them,
  and unsandboxed pnpm then writes only there), and `--store-dir` and `--state-dir` do the same. Inside the
  sandbox the same lock error remains, with `TMPDIR` exported to the lane's own directory. pnpm takes the lock with
  `flock` on a file whose location is UNKNOWN; neither the error, the sandbox's debug output nor the system log
  names it.

### Evidence

```
CALL pnpm add is-number@7.0.0 [canUseTool(This command requires approval),hook] → Exit code 1 ⏎ Error: ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK
CALL npm install is-odd@3.0.1 [canUseTool(This command requires approval),hook] → npm error code EPERM ⏎ npm error path ~/.npm/_cacache/tmp/***
CALL pnpm add is-number@7.0.0 [canUseTool(spike 14 hook: ask),hook]
CALL pnpm add is-number@7.0.0 --store-dir .pnpm-store [canUseTool(This command requires approval),hook] → Error: ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK
```

## What this means for 10db

- **D2: build the deny-`/` form.** It is the strongest form, and node, pnpm, mise and git run under it with the
  list in check 5. The lane env sets `GIT_CONFIG_GLOBAL=/dev/null`. Secret files in the checkout are listed by
  exact path, until a glob in `denyRead` is shown to work.
- **D14: each lane gets its own temp directory through `CLAUDE_CODE_TMPDIR`.** The path must be 44 bytes or less,
  or Claude Code falls back to the shared `/tmp/claude-<uid>` without a word, so 10db refuses to start a session
  whose path is longer. Every temp root, the shared one included, stays denied.
- **D8: Claude Code's link resolution is the first layer.** A deny rule and a scoped allow rule both resolve links
  in 2.1.310. The guard's resolved-path check is the second layer. Grep's `path` is the shape that crosses a link.
- **D1: validate the profile.** An invalid sandbox value turns the sandbox off without an error. 10db builds no
  patterns, checks the profile against a strict schema, and a live test proves the built profile denies a canary.
- **D3: the mechanism is sound.** With auto-allow off, every non-read-only command reaches the broker, a real
  dependency change included.
- **Dependency installs use per-project caches (the builder's choice).** npm works with its cache in the checkout.
  pnpm 12's `add` still fails on its store lock inside the sandbox, so an approved pnpm dependency change can't run
  in a lane until that lock is found.

## Gaps that remain

- `denyRead` with a glob, for `.env*` files made after the session starts.
- Where pnpm 12 takes its store operation lock, and how to move it into the checkout.
- How a sandbox that never starts is reported (macOS gave no way to stop it).
- Whether other invalid values also drop the sandbox. Only an invalid `extract` was tried.
- Minimality of the toolchain list, and cargo.
- Everything under `srt` itself (check 13), and the whole gate (check 15).
