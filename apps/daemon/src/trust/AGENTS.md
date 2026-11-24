# apps/daemon/src/trust

- `trust/` builds each session's `TrustPolicy` (`@10db/contracts`): the four limits, whose prose lives in one
  place (`trust/limits.ts`), the environment the judge reads them in, and the coordination lines of its surface.
- 10db's judge: `fast-path.ts` (`fastPathAllows`, `namesSecret`; its `JUDGED_OWN_TOOLS`, a chat's push, pull request and merge, are never fast) answers the calls that can't cross a limit
  with no model, a shell command only when every segment is in `read-allowlist.ts` (each read command with the
  only options it may carry, and its files regular, non-secret and inside the checkout or the temp dir, which the Read, LS, Glob and Grep tools meet too, and a path of theirs that starts with `~` or has leading or trailing whitespace goes to the judge, since Claude Code trims and expands it; a Glob runs `rg --files --null --glob <pattern> --sort=modified --no-ignore --hidden` in its search folder, which follows no link inside the tree, so only the search folder, the pattern's literal prefix and its syntax are checked (a `RIPGREP_CONFIG_PATH` is Claude Code's own environment, which the agent can't set); `ls` and `stat` never carry `-L`, which would follow a link inside the checkout out of it; `git log --stat` runs no textconv driver, since a diffstat counts lines of the stored blobs, and the driver's command could only come from the git config the agent can't write); `crosses-limit.ts` asks the `crosses_limit` decision the rest, with the call fenced as data, and
  reads `unsure`, a below-floor `allow` (except for a Bash call that only runs files of the checkout with operands inside it or the temp dir, `checkout-program.ts`: the sandbox contains the repo's own script, which the judge can't read, so a lean towards allow runs it) and an input over `CALL_INPUT_MAX_CHARS` as a limit; `grants.ts` turns a
  project's grants (`trust_grants`) into the allow lines every judge reads (`grantTargetOf` keeps a note on one line
  or quotes the call). A grant of a quoted call is the agent's text, so no judge reads it: `projectGrantedCalls`
  matches it exactly against `grantCallSummary` of a call (a Bash command as written, but only while it carries no field beyond
  `command`, `description` and `timeout`; else the input as JSON), in the hook judge on a native session and a `tendb` one
  alike (a hook's `allow` ends the check, so Claude's auto mode classifier never sees the call) and in the broker
  before a limit or escalation card. Codex's hook can't approve a call, so a granted call there still meets Auto-review
  when it escalates; only 10db's judge honours the grant ahead of a model. `call-judge.ts` starts a `tendb` session on the rules when 10db's judge isn't ready.
- The fast path also reads a Markdown file in the session's setup with no model, for Read, Grep and the listed read commands on that file (a listing of a setup folder, a Glob and an edit still go to the judge), its name and every real path it leads to ending in `.md`: every reading of it must be inside one of `FastPathContext.setupReads`, the setup folders the profile opens (`FileAccessContext.setupReads`), so an advertised `SKILL.md` and its references cost no judge call while a skill's or plugin's other files still go to the judge. A path in a secret folder counts as a secret everywhere (`namesSecret`).
- The hook judge that runs them is `inbox/hook-judge.ts` (`createHookJudge`, `LimitNotes`); the card a noted limit
  raises is `inbox/limit-card.ts`, with the three answers, and Always in this project stores a grant in the
  answer's write (`inbox/service.ts`).
