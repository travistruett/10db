# Spike 13: Claude Code's Bash sandbox as the boundary for lanes

- **Status:** PARTIAL. Checks 1–6, 8 and 9 are VERIFIED. Checks 2–4 come from the builder's own script run.
  Check 10 is REFUTED: no configuration tried makes `make gate` pass inside the sandbox. Check 7 was not run; it
  rests on the documented behavior.
- **Date:** 2026-10-25
- **Versions:** claude 2.1.310 (Claude Code) · Agent SDK 0.3.300 · Node v26.12.0
- **Command:** `pnpm --dir spikes/agent-sdk spike:13 <engage | env | read | perms | network | gate>`

The sandbox is `Options.sandbox` (Seatbelt on macOS), set per session through the SDK. Every session ran on
`haiku` with effort `low`, billed to the subscription (`apiKeySource` none, `apiProvider` firstParty,
`subscriptionType` Claude Max), with `maxBudgetUsd: 0.5`. Haiku ran every listed command verbatim and declined
nothing, so no check is marked PARTIAL for a refusal. The probe adds an operator note to the system prompt saying
the commands are a sanctioned test of the sandbox. An earlier haiku run declined the bypass battery even with
that note, so checks 2–4 ran as a plain script with no model.

The lane base config for every check except 1's control is:

```json
{
  "enabled": true,
  "failIfUnavailable": true,
  "allowUnsandboxedCommands": false,
  "filesystem": {
    "denyRead": [
      "~/.10db-spike13-canary",
      "~/.claude.json",
      "~/.claude",
      "~/Library/Keychains",
      "~/Library/Application Support/10db"
    ]
  }
}
```

## Summary

| #   | Check                  | Result   | Evidence file (in `spikes/agent-sdk/out/`)                                                      |
| --- | ---------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| 1   | Sandbox engages        | VERIFIED | `13-engage.json`, `13-engage-control.json`, `13-run-engage.txt`                                 |
| 2–4 | File denial, Keychain  | VERIFIED | `13-partA/summary.txt` (the builder's run of `13-partA.sh`)                                     |
| 5   | Environment scrub      | VERIFIED | `13-env-baseline.json`, `13-env-scrub.json`, `13-env-credentials-deny.json`                     |
| 6   | Read tool routing      | VERIFIED | `13-read-denyread-only.json`, `13-read-disallowed-rule.json`, `13-read-settings-deny.json`      |
| 7   | Escape hatch           | NOT RUN  | documented behavior only                                                                        |
| 8   | Cards versus hooks     | VERIFIED | `13-perms-autoallow.json`, `13-perms-no-autoallow.json`                                         |
| 9   | Network allowlist      | VERIFIED | `13-network-default-asks-allowed.json`, `13-network-default.json`, `13-network-one-domain.json` |
| 10  | Gate under the sandbox | REFUTED  | `13-gate-quick.json`, `13-gate-fullA.json`, `13-gate-fullB.json`, `13-gate-fullB-logs/`         |

## 1. The sandbox engages through the SDK (`engage`): VERIFIED

### Question

Does `Options.sandbox` start Claude Code's Seatbelt sandbox for a session, so that writes outside the working
directory fail and a denied path cannot be read?

### Result

Yes. One session ran six Bash commands under the base config. A control session with no `sandbox` option read the
canary file.

- **Writes.** A write to `~` failed (`Operation not permitted`), as did a write to `/tmp`. A write in the cwd
  worked, and so did one under `$TMPDIR`. Inside the sandbox `$TMPDIR` is `/tmp/claude-501`, not the macOS
  `/var/folders` directory.
- **Reads.** `cat` of a file under a `denyRead` directory failed with `Operation not permitted`. Without the
  sandbox the same `cat` printed the token.
- **Proof the runtime applied it.** With `SRT_DEBUG=1`, stderr logs `Applied restrictions - network: true, read:
denyAllExcept, write: denyAllExcept` for each command.
- **User settings are ignored.** The debug log says `ignoring permission rules and sandbox.filesystem entries
from disabled setting source userSettings`; the session loads `settingSources: ['project']` only.

### Evidence

```
PASS control: without the sandbox, the canary is readable: «canary:secret»
PASS engage: the session ran under the sandbox config: success
PASS engage: a write to ~ failed: touch: /Users/travistruett/.10db-spike13-write-probe: Operation not permitted
PASS engage: a write in the cwd worked: wrote-cwd
INFO engage: /tmp write: {"exists":false,"output":"touch: /tmp/s13-tmp-write: Operation not permitted\ntmp-write-denied"}
INFO engage: $TMPDIR write: wrote-tmpdir
PASS engage: cat ~/.10db-spike13-canary/secret.txt: no token → Exit code 1 ⏎ cat: ...: Operation not permitted
PASS engage: the sandbox runtime reports restrictions applied to each command: [SandboxDebug] [Sandbox macOS] Applied restrictions - network: true, read: denyAllExcept, write: denyAllExcept
```

## 2–4. File denial and Keychain (`13-partA.sh`): VERIFIED

The builder ran these from their own terminal as a plain script, `spikes/agent-sdk/13-partA.sh`, with no model
in the loop. It runs each command under `srt` (`@anthropic-ai/sandbox-runtime` 0.0.81, the library Claude Code's
Bash sandbox is built on), with the lane deny list above. It writes only to the working directory. Every content
check reads a canary with a random token: `~/.10db-spike13-canary/` and a login-Keychain item. The script
removes both on exit and confirms they are gone. Real credential paths are probed only for size or entry count.

Controls: without the sandbox the canary is readable. Under it, a direct `cat` is refused, a write in the cwd
works and a write to `~` is refused.

### 2. File-denial routes: VERIFIED

- **Question:** does `denyRead` on a directory hold against every read route (copies, links, archives, other
  interpreters, path spellings)?
- **Result:** yes. All 25 routes were refused with `Operation not permitted`, and no token appeared:
  - `head`, `dd`, `cp`, `cp -c` (APFS clone);
  - `tar` from `-C ~`, `zip -r`, `ditto`, `rsync`;
  - `$(…)` in a subshell after `cd ~`, a glob, `find -exec cat`, `grep -r`;
  - python, node, perl and `osascript` reads;
  - a symlink in the cwd (the read through it is refused) and a hard link (`ln` itself is refused);
  - a case-changed path, `./` and `//`, `~/../$USER/`, the `/System/Volumes/Data` firmlink, a `/.vol/<dev>/<inode>`
    path;
  - a `launchctl submit` job meant to copy the file outside the sandbox (no job wrote anything).
- **Evidence:** `out/13-partA/summary.txt` and one output file per row. For example, `f-tar.txt` reads `tar:
.10db-spike13-canary: Couldn't visit directory`, and `f-hardlink.txt` reads `ln: …/secret.txt: Operation not
permitted`.

### 3. Real credential paths: VERIFIED

- **Question:** do `~/.claude.json`, `~/.claude`, `~/Library/Keychains` and the 10db data directory stay
  unreadable?
- **Result:** `wc -c < ~/.claude.json`, `ls ~/.claude` and `wc -c < ~/Library/Keychains/login.keychain-db` were all
  refused (exit 1). The 10db data directory doesn't exist on this machine, so that row only shows that the probe
  ran. That the session still runs with these paths denied was shown through the SDK in check 1, because the
  claude process itself is outside the Bash sandbox.
- **Evidence:** `out/13-partA/r-*.txt`.

### 4. Keychain: VERIFIED, with one open detail

- **Question:** with `~/Library/Keychains` denied, does `security find-generic-password -w` return a canary item?
  What if the directory is not denied, or the `security` binary is denied?
- **Result:**
  - **Denied directory:** the item is not found (exit 44, "could not be found in the keychain"). The binary's
    Seatbelt profile allows `mach-lookup` to `com.apple.SecurityServer` and `com.apple.securityd.xpc`, and the
    settings can't remove that. Even so, the client can't open the keychain file, and that is enough.
  - **Directory not denied:** the canary is printed. The `~/Library/Keychains` entry is the setting that protects
    login-keychain items, and 10db keeps keyed-account secrets there.
  - **`/usr/bin/security` in `denyRead`:** the binary can't run at all (exit 127).
  - **Open:** `security dump-keychain` under the lane config still prints 3253 lines of metadata. No secrets
    appeared, and no canary. It probably lists the System keychains outside the denied directory. The run kept a
    line count only, so this is unconfirmed; `security dump-keychain | grep -c 10db-spike13-canary` would settle
    it.
- **Evidence:** `out/13-partA/k-*.txt`.
- **Version caveat:** these rows ran under srt 0.0.81. The copy bundled in claude 2.1.310 may differ. Check 1
  showed that the SDK path applies the same `denyAllExcept` restrictions, and its direct read was refused the same
  way.

## 5. Environment scrub (`env`): VERIFIED

### Question

Does a credential in the session environment reach a sandboxed Bash command? Do
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` or `sandbox.credentials.envVars` keep it out?

### Result

Two fake values, random per run, were put in the session `env`: `AWS_SECRET_ACCESS_KEY` and
`TENDB_SPIKE13_CANARY`. No `ANTHROPIC_*` value was faked. The model ran `env | grep -c '^NAME='` for each, which
prints a count and never a value.

| Run                                                              | `AWS_SECRET_ACCESS_KEY` | `TENDB_SPIKE13_CANARY` |
| ---------------------------------------------------------------- | ----------------------- | ---------------------- |
| baseline                                                         | 1                       | 1                      |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`                             | 0                       | 1                      |
| `sandbox.credentials.envVars` deny for both names (`mode: deny`) | 0                       | 0                      |

- **The sandbox does not scrub the environment.** Both values reached the shell in the baseline.
- **The scrub is by name and value shape.** The docs (https://code.claude.com/docs/en/env-vars, "What the
  subprocess environment scrub removes") say the scrub "recognizes a credential by its variable name or by the
  shape of its value". It removes `ANTHROPIC_API_KEY` and `AWS_SECRET_ACCESS_KEY`, removes names that look like a
  credential (`NPM_TOKEN`, `DB_PASSWORD`), removes a `DATABASE_URL` whose value holds a password, strips the
  password from a registry URL, and removes `CLAUDE_CONFIG_DIR`. It leaves `GITHUB_TOKEN`, `GH_TOKEN`,
  `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`, `HTTP_PROXY` and `HTTPS_PROXY`, and `GIT_CONFIG_*`. It
  leaves "a secret whose variable name and value don't look like a credential", which is what
  `TENDB_SPIKE13_CANARY` is. The run matches the table.
- **`credentials.envVars` deny is by exact name.** It removed both, including the one the scrub leaves.
  `SandboxSettings.credentials.envVars` takes `{ name, mode: 'deny' | 'mask' }` entries.
- **An observation not explained.** In the scrub run both Bash calls reached `canUseTool`; in the other two runs
  none did. Nothing in the run says why.

### Evidence

```
INFO env-baseline: env | grep -c '^AWS_SECRET_ACCESS_KEY=': {"count":"1","isError":false}
INFO env-baseline: env | grep -c '^TENDB_SPIKE13_CANARY=': {"count":"1","isError":false}
INFO env-scrub: env | grep -c '^AWS_SECRET_ACCESS_KEY=': {"count":"0","isError":false}
INFO env-scrub: env | grep -c '^TENDB_SPIKE13_CANARY=': {"count":"1","isError":false}
INFO env-credentials-deny: env | grep -c '^AWS_SECRET_ACCESS_KEY=': {"count":"0","isError":false}
INFO env-credentials-deny: env | grep -c '^TENDB_SPIKE13_CANARY=': {"count":"0","isError":false}
```

## 6. Read tool routing (`read`): VERIFIED

### Question

Does `sandbox.filesystem.denyRead` stop the Read tool? If not, does a `Read(...)` deny rule?

### Result

- **`denyRead` alone does not stop the Read tool.** The Read tool returned the token. The file sits outside the
  working directory, so the call went to `canUseTool` with the reason `Path is outside allowed working
directories`; an allowing callback released the token. The docs say the same: "A `denyRead` entry doesn't stop
  the Read tool."
- **A `Read(...)` deny rule stops it.** With `disallowedTools: ['Read(~/.10db-spike13-canary/**)']`, and with the
  same rule in `settings.permissions.deny`, the call returned `File is in a directory that is denied by your
permission settings`, with no `canUseTool` call and no hook call.
- **The rule also reaches the sandbox.** With the canary left out of `denyRead` and only the `Read(...)` rule set,
  a Bash `cat` of the file was denied (`Operation not permitted`). A Read deny rule therefore covers both the
  Read tool and Bash, and Read deny rules are the one list to maintain.
- **Path syntax differs.** Sandbox paths use `~/` and `/abs`; Read rules use `//abs` and `/project-relative`.

### Evidence

```
CALL Read {"file_path":"/Users/travistruett/.10db-spike13-canary/secret.txt"} [canUseTool,hook] → 1	«canary:secret»
ASKED Read ... reason=Path is outside allowed working directories → allow
INFO read-denyread-only: the Read tool ignores sandbox.filesystem.denyRead: true
PASS read-disallowed-rule: the Read tool is denied: <tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>
PASS read-settings-deny: the Read tool is denied: <tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>
INFO read-rule-into-sandbox: Bash cat with only the Read(...) deny rule: {"leaked":[],"output":"Exit code 1\ncat: ...: Operation not permitted"}
```

## 7. The unsandboxed retry: NOT RUN

Not run, by the builder's decision. The docs (https://code.claude.com/docs/en/sandboxing, "`allowUnsandboxedCommands`
and the `dangerouslyDisableSandbox` escape hatch") say:

- Claude may retry a command that failed in the sandbox with the `dangerouslyDisableSandbox` parameter. In
  `bypassPermissions` mode the retry runs without a prompt. A matching allow rule such as `Bash(curl *)` also
  approves it.
- With `"allowUnsandboxedCommands": false`, "Claude Code ignores the `dangerouslyDisableSandbox` parameter", so
  commands are sandboxed unless they match an `excludedCommands` entry. `failIfUnavailable` keeps commands from
  running unsandboxed when the sandbox cannot start.
- A `false` set through `--settings` or managed settings holds even when a project's settings say `true`.

The base config above sets `allowUnsandboxedCommands: false` and `failIfUnavailable: true`. The probe's `escape`
subcommand exists to test this and has not been run. One related observation from check 10: a command listed in
`excludedCommands` (`ps`) still failed with `operation not permitted`, so that list did not unsandbox it.

## 8. Cards versus hooks (`perms`): VERIFIED

### Question

Which Bash calls reach `canUseTool` and which reach a `PreToolUse` hook, with `autoAllowBashIfSandboxed` true and
false? 10db must turn a dependency command such as `pnpm add` into a human card.

### Result

A `canUseTool` callback that records and allows, and a `PreToolUse` hook that records, were registered. The model
ran `git status` and `pnpm add --help` (harmless, and shaped like `pnpm add <package>`).

| `autoAllowBashIfSandboxed` | `git status`: canUseTool / hook | `pnpm add --help`: canUseTool / hook |
| -------------------------- | ------------------------------- | ------------------------------------ |
| true                       | no / yes                        | no / yes                             |
| false                      | no / yes                        | yes / yes                            |

- **The hook sees every Bash call, in both modes.**
- **With auto-allow on, no Bash call reaches `canUseTool`.** The sandbox is treated as the approval, so a
  dependency command runs with no card. 10db cannot use a `canUseTool` card for this unless the hook, or an
  `ask` rule, forces the question.
- **With auto-allow off, only a command Claude Code does not treat as read-only reaches `canUseTool`.**
  `pnpm add --help` arrived with the reason `This command requires approval`; `git status` did not.
- **Not tested:** `ask` permission rules and a hook returning `ask` (the probe code is not run here), and a real
  `pnpm add <package>` rather than `--help`.

### Evidence

```
INFO perms-autoallow: per command: [{"cmd":"git status","canUseTool":false,"hook":true},{"cmd":"pnpm add --help","canUseTool":false,"hook":true}]
INFO perms-no-autoallow: per command: [{"cmd":"git status","canUseTool":false,"hook":true},{"cmd":"pnpm add --help","canUseTool":true,"hook":true}]
ASKED Bash {"command":"pnpm add --help",...} reason=This command requires approval → allow
```

## 9. Network allowlist (`network`): VERIFIED, with a different mechanism than expected

### Question

With the default (empty) `network.allowedDomains`, does a sandboxed command reach example.com, GitHub or
`gh`? After adding `example.com`, does only example.com open?

### Result

An empty allowlist does not close the network. A host that is not listed raises a `canUseTool` request for the
tool `SandboxNetworkAccess` with input `{ host }`. What the callback answers decides.

- **Callback allows every request.** `curl https://example.com` printed `200`, `git ls-remote
https://github.com/sst/opencode HEAD` printed a commit hash, and `gh auth status` reached the host. Requests
  were made for `example.com`, `github.com` and `api.github.com`.
- **Callback denies non-Bash tools (the 10db answer).** `curl` failed with `CONNECT tunnel failed, response 403`
  and `deny network-outbound example.com:443 (user denied)`; `git ls-remote` failed the same way for
  `github.com:443`.
- **`allowedDomains: ['example.com']`, same denying callback.** `curl` printed `200` with no request to the
  callback; `git ls-remote` was denied. Only example.com opened, as expected.
- **`gh` could not use the keyring token in the sandbox.** `gh auth status` reported `The token in default is
invalid`; outside the sandbox it reports a valid login from the keyring. The denied Keychain path explains it
  (not isolated by a run).

So the allowlist is a fast path that skips the question, not a wall. The wall is the callback: 10db's
`canUseTool` must deny `SandboxNetworkAccess` (or show a card) for unlisted hosts.

### Evidence

```
PASS network-default: example.com is blocked: Exit code 56 ⏎ curl: (56) CONNECT tunnel failed, response 403 ⏎ 000 ⏎ <sandbox_violations> ⏎ deny network-outbound example.com:443 (user denied)
INFO network-default-asks-allowed: non-Bash canUseTool requests: [{"tool":"SandboxNetworkAccess","input":{"host":"example.com"},"decision":"allow"},{"tool":"SandboxNetworkAccess","input":{"host":"github.com"},...},{"tool":"SandboxNetworkAccess","input":{"host":"api.github.com"},...}]
PASS network-one-domain: example.com opens: 200
INFO network-one-domain: git ls-remote ...: Exit code 128 ⏎ fatal: unable to access 'https://github.com/sst/opencode/': CONNECT tunnel failed, response 403
```

## 10. The gate under the sandbox (`gate`): REFUTED

### Question

Can a lane run `pnpm typecheck`, tests, git and `make gate` inside the sandbox? What are the smallest additions to
the base config that make `make gate` print `GATE PASS`? Unsandboxed, it passes in about 185 s.

### Result

`pnpm install --frozen-lockfile` ran first, outside any session. Then, through the sandboxed Bash tool (timeout
600000 ms, cwd the worktree):

| Command                                                 | Result under the base config                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                        | passes                                                                                                                     |
| `pnpm --filter @10db/contracts test`                    | prints nothing: the package has no `test` script; its tests ran with `pnpm exec vitest run --project contracts`, 334 pass  |
| `git status`                                            | works                                                                                                                      |
| `git init` and a commit in a temp repo under the cwd    | fails: `fatal: cannot copy '.../hooks/commit-msg.sample' to '<cwd>/.s13-tmp-repo/.git/hooks/...': Operation not permitted` |
| the same with `--template=`                             | fails: `could not write config file <cwd>/.s13-tmp-repo/.git/config: Operation not permitted`                              |
| `git init`, config and commit in a repo under `$TMPDIR` | works                                                                                                                      |
| `make gate`                                             | fails                                                                                                                      |

**Causes of the failures, and the addition that fixed each:**

1. **A server listening on 127.0.0.1** (`listen EPERM: operation not permitted 127.0.0.1`; in the run with no
   additions, all 18 tests in `start.test.ts` and 4 in `batch-delivery.test.ts` failed). Fixed by `network.allowLocalBinding: true`.
2. **`fs.watch`** (`watcher.test.ts`, `crash-recovery.test.ts`: `waitFor timed out`). Fixed by
   `network.allowMachLookup: ['com.apple.FSEvents']`.
3. **A unix socket in the temp directory** (tsx, which runs `build`, `e2e`, `drift` and `rust`:
   `listen EPERM ... /tmp/claude-501/tsx-501/<pid>.pipe`). Fixed by `network.allowUnixSockets:
['/tmp/claude-501']`. A narrower path was not tried.
4. **No network or cache failure.** Nothing needed `network.allowedDomains`, a write outside the cwd, `~/.cargo` or
   the pnpm store. `cargo check` (the `rust` step) and `drizzle-kit` ran with the base config plus the three
   additions above.

**Two steps still failed with every configuration tried** (`13-gate-fullB.json`; `GATE FAIL: test e2e (85s)`):

- **`test`: 7 tests in 2 files** (`src/recovery/recover.test.ts` and `src/delivery/recover.test.ts`) fail with `ps
could not see the child`; they call `ps`. `/bin/ps` is setuid root (`-rwsr-xr-x`) and `exec` of it returns `operation not permitted` in
  the sandbox, from a shell and from `execFileSync` (`spawnSync ps EPERM`). It runs fine with the sandbox off. The
  3017 other tests pass. `filesystem.allowRead` for `/bin/ps`, `excludedCommands: ['ps']` and
  `enableWeakerNestedSandbox`/`enableWeakerNetworkIsolation` changed nothing. Code that identifies a process with `ps`
  would hit the same wall inside a lane.
- **`e2e`**: `e2e/prepare.ts` runs `git init` for a repo under `apps/desktop/.e2e`, inside the cwd. Git cannot
  write `.git/hooks` or `.git/config` there. `filesystem.allowWrite` for that directory did not lift it (these
  paths are protected inside any writable directory). A leftover `.git/config` from an unsandboxed run also stops
  the sandbox from clearing the directory (`ENOTEMPTY`), because it cannot delete the file either.

The first attempt ran `make gate` with none of the three additions and ran 30 minutes before being stopped:
failing server tests wait out their 10 s timeouts. The model also started `make gate` in the background, which
kept the session open; the prompt now says to run in the foreground.

With the three additions, 7 of 9 gate steps pass: `format lint typecheck build drift knip rust`. `test` and `e2e`
fail.

### Evidence

```
CALL pnpm exec vitest run --project daemon src/daemon/start.test.ts ... → 1 Error: listen EPERM: operation not permitted 127.0.0.1
CALL ps -p 1 -o pid= → Exit code 127 ⏎ (eval):1: operation not permitted: ps          (sandbox on)
CALL ps -p 1 -o pid= →     1                                                            (sandbox off)
CALL unix-listen under /tmp/claude-501 with allowUnixSockets → unix-listen-ok
fullA (allowLocalBinding + FSEvents):  GATE FAIL: test build e2e drift rust (71s)
fullB (+ allowUnixSockets):            GATE FAIL: test e2e (85s)
fullB test.log:   Test Files  2 failed | 136 passed | 1 skipped (139)   Tests  7 failed | 3017 passed
```

## What this means for 10db

### The lane `sandbox` config that came closest

```json
{
  "enabled": true,
  "failIfUnavailable": true,
  "allowUnsandboxedCommands": false,
  "autoAllowBashIfSandboxed": false,
  "network": {
    "allowLocalBinding": true,
    "allowMachLookup": ["com.apple.FSEvents"],
    "allowUnixSockets": ["/tmp/claude-501"]
  },
  "filesystem": {
    "denyRead": [
      "~/.claude.json",
      "~/.claude",
      "~/Library/Keychains",
      "~/Library/Application Support/10db"
    ]
  }
}
```

No configuration passed the whole gate. This one passed seven of nine steps (the run set `autoAllowBashIfSandboxed`
at its default; the `false` is the recommendation from check 8, not part of the gate run). The two that failed are
not fixable from `Options.sandbox`: `ps` cannot be executed, and a git repository cannot be created under the
cwd. Either the gate's `test` and `e2e` steps run outside the lane's sandbox (the daemon's verification step is the natural place), or the tests that need `ps` and the e2e repo move out of the lane's reach.

Other findings that shape the config:

- A lane commits in its worktree; whether a commit from a linked worktree works (its gitdir sits outside the cwd)
  is the `worktree` subcommand and has not been run.
- Repos created under `$TMPDIR` work, so the test suites' fixture repositories are fine.
- `gh` cannot read the Keychain token in the sandbox. That is the intended containment, and the daemon, not the
  lane, runs `gh`.

### Gaps that remain

- **The Read tool, hooks and MCP servers are not sandboxed.** `denyRead` does not cover Read (check 6). Mirror each
  `denyRead` entry as a `Read(...)` deny rule, which also reaches the sandbox. The docs state that file tools, MCP
  servers and hooks "run outside" the sandbox; this spike did not test an MCP server or a hook process.
- **Cards versus auto-allow (check 8).** With `autoAllowBashIfSandboxed` true, a dependency command never reaches
  `canUseTool`. Use `false` and gate on `canUseTool`, or make the `PreToolUse` hook, which sees every call,
  return `ask` for the hazard commands. The `ask` paths were not run.
- **The network wall is the callback (check 9).** Deny `SandboxNetworkAccess` for hosts the project did not list.
- **Credentials in the environment (check 5).** The sandbox does not strip them. Use
  `credentials.envVars` deny by name for each secret the daemon holds; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` misses
  a variable whose name and value do not look like a credential, and leaves GitHub tokens.
- **Keychain metadata (check 4).** `security dump-keychain` still lists 3253 lines of item metadata under the lane
  config, with no secrets. It is probably the System keychains; that is unconfirmed. Denying `/usr/bin/security`
  as well would close it.
- **Daemon reads.** The Bash sandbox doesn't cover the daemon. A lane can commit a symlink, for example
  `.github/pull_request_template.md` pointing to `~/.claude.json`, and the daemon follows it when it reads the
  repo. Creating a link never reads its target, so no sandbox stops it.
- **The unsandboxed retry (check 7).** Documented, not run. Keep `allowUnsandboxedCommands: false`.
- **Unverified minimality.** Each of the three network additions was seen to fix a failure; none was removed one at
  a time from the final config to show it is still needed, and `/tmp/claude-501` is wider than the one tsx
  directory.
