# Spike 15: What gh prints for required checks, a failed job's log and auto-merge

- **Status:** PARTIAL. Passing checks, no required checks, a completed failed job's log and signed out are
  VERIFIED against travistruett/10db. Pending, failing, cancelled, no checks at all, a run in progress and
  `gh pr merge --auto` with auto-merge already on were not observed. Those rows come from the message strings
  in the installed gh binary and from gh's source, and are marked as such.
- **Date:** 2026-10-31
- **Versions:** gh 2.83.2 (2025-12-10)
- **Command:** a throwaway script that ran each command below and recorded the exit code, stdout and stderr.
  The builder ran it with a signed-in gh, because the lane's gh was signed out and its sandbox blocks
  GitHub.

The checks come from the CI-decides design, `docs/superpowers/specs/2026-10-31-10db-ci-decides-design.md` §4
and §6 (build task T3). The parsers are `parseRequiredChecks` and `parseJobLog` in
`apps/daemon/src/github/gh.ts`. Their fixtures in `ci-checks.test.ts` copy the observed output verbatim
(`SPIKE_*`).

## `gh pr checks <url> -R <repo> --required --json name,state,bucket,link,workflow,description`

| Case                                    | Exit | stdout                     | stderr                                                                           | Source   | Read as                |
| --------------------------------------- | ---- | -------------------------- | -------------------------------------------------------------------------------- | -------- | ---------------------- |
| every required check passed (#193)      | 0    | JSON list, one per check   | empty                                                                            | observed | `passing`              |
| checks, none required (#194, into next) | 1    | empty                      | `no required checks reported on the 'fix/next-live-test-logger' branch`          | observed | `none`                 |
| signed out                              | 4    | empty                      | `To get started with GitHub CLI, please run:  gh auth login` and a GH_TOKEN line | observed | unknown (`signed_out`) |
| one pending                             | 8    | JSON list                  | empty                                                                            | gh docs  | `pending`              |
| one failed                              | 1    | JSON list                  | empty                                                                            | gh docs  | `failing`              |
| one cancelled                           | 1    | JSON list, bucket `cancel` | empty                                                                            | gh docs  | `pending`              |
| the head has no checks at all           | 1    | empty                      | `no checks reported on the '<branch>' branch`                                    | binary   | `none`                 |

Observed:

- **A passing entry** is
  `{"bucket":"pass","description":"","link":"https://github.com/travistruett/10db/actions/runs/41233997988/job/124633840932","name":"desktop","state":"SUCCESS","workflow":"ci"}`.
  The link has the form `…/actions/runs/<run>/job/<job>`, which is where the run and job ids come from.
  `description` is an empty string, not null, so the parser reads `""` as no description.
- **No required checks** is an error, not an empty list: exit 1, nothing on stdout, and the message on stderr
  with a newline. A network error also exits 1, so the parser reads `none` only when exit 1, an empty stdout
  and the whole of stderr (trimmed) is gh's message. Anything else with exit 1 and no list is unknown.

Not observed:

- **No checks at all.** gh 2.83.2's binary has both `no checks reported on the '%s' branch` and
  `no required checks reported on the '%s' branch`. In gh's source the first comes when the head commit has no
  checks at all, before the filter to `--required`. A base with no CI, or a pull request pushed before GitHub
  lists its runs, gets that message with `--required` too. Both messages are therefore read as `none`.
- **Exit codes 1 (failed) and 8 (pending)** with the list on stdout are from gh's help.

## `gh run view --job <id> -R <repo> --log-failed`

| Case                           | Exit | stdout                                     | stderr                                                                      | Source   | Read as   |
| ------------------------------ | ---- | ------------------------------------------ | --------------------------------------------------------------------------- | -------- | --------- |
| a completed failed job         | 0    | the log, `<job>\t<step>\t<timestamp> text` | empty                                                                       | observed | `ready`   |
| a job whose run is in progress | 1    | empty                                      | `job <id> is still in progress; logs will be available when it is complete` | binary   | `not_yet` |
| signed out                     | 4    | empty                                      | as above                                                                    | observed | unknown   |

Observed for job 124622919963 (a failed `desktop` job): **every line's step was `UNKNOWN STEP`**, and gh printed
the whole job's log, from `Current runner version` on, not only the failed step's lines. The first line's
timestamp follows a byte order mark (U+FEFF). For T7: the excerpt (the last 300 lines) still ends at the
failure, but nothing can be cut by step name, and a BOM has to be stripped along with the ANSI codes.

Not observed: the in-progress message, whose text is from the binary (`job %d is still in progress; …` and
`run %d is still in progress; …`). The parser matches the whole of stderr against either one.

## `gh pr merge <url> --auto --squash` with auto-merge already on

Not run: it changes the pull request, and no pull request with auto-merge on was free to try it on. The
binary has `Auto-merge enabled…` and `Auto-merge disabled for pull request…`, but no message for "already
enabled". The spec's rule stands until this is observed: when the fix ship's re-arm gets an error back, it
treats the pull request as armed and does not raise the refused card (spec §6).
