# Spike 15: What gh prints for required checks, a failed job's log and auto-merge

- **Status:** PARTIAL, one row left. VERIFIED against travistruett/10db: passing, pending, failing and
  cancelled checks, no required checks, a completed failed job's log, a log asked for while the job runs,
  `gh pr merge --auto` with auto-merge already on, and signed out. Not yet observed: a head with no checks at
  all. No pull request was in that state on 2026-11-02, and the builder chose not to make a throwaway one.
  That row comes from gh's source and the message strings in its binary, and is marked that way.
- **Date:** 2026-10-31. Pending, failing, in progress and re-arm were captured 2026-11-02T04:56Z, cancelled
  at 2026-11-02T12:50Z.
- **Versions:** gh 2.83.2 (2025-12-10)
- **Command:** each command below, with its exit code, stdout and stderr recorded verbatim. The builder (or
  the orchestrator) ran them with a signed-in gh. The lane's gh is signed out, its sandbox blocks GitHub,
  and its hook forbids `gh pr merge`.

The checks come from the CI-decides design, `docs/superpowers/specs/2026-10-31-10db-ci-decides-design.md` §4
and §6 (build task T3). The parsers are `parseRequiredChecks` and `parseJobLog` in
`apps/daemon/src/github/gh.ts`. Their fixtures in `ci-checks.test.ts` copy the observed output verbatim
(`SPIKE_*`).

## `gh pr checks <url> -R <repo> --required --json name,state,bucket,link,workflow,description`

| Case                                    | Exit | stdout                      | stderr                                                                           | Source   | Read as                |
| --------------------------------------- | ---- | --------------------------- | -------------------------------------------------------------------------------- | -------- | ---------------------- |
| every required check passed (#193)      | 0    | JSON list, one per check    | empty                                                                            | observed | `passing`              |
| checks, none required (#194, into next) | 1    | empty                       | `no required checks reported on the 'fix/next-live-test-logger' branch`          | observed | `none`                 |
| signed out                              | 4    | empty                       | `To get started with GitHub CLI, please run:  gh auth login` and a GH_TOKEN line | observed | unknown (`signed_out`) |
| two required checks running (#245)      | 0    | JSON list, bucket `pending` | empty                                                                            | observed | `pending`              |
| one required check failed (#242)        | 0    | JSON list, bucket `fail`    | empty                                                                            | observed | `failing`              |
| one required check cancelled (#333)     | 0    | JSON list, bucket `cancel`  | empty                                                                            | observed | `cancelled`            |
| the head has no checks at all           | 1    | empty                       | `no checks reported on the '<branch>' branch`                                    | binary   | `none`                 |

Observed:

- **A passing entry** is
  `{"bucket":"pass","description":"","link":"https://github.com/travistruett/10db/actions/runs/41233997988/job/124633840932","name":"desktop","state":"SUCCESS","workflow":"ci"}`.
  The link has the form `…/actions/runs/<run>/job/<job>`, which is where the run and job ids come from.
  `description` is an empty string, not null, so the parser reads `""` as no description.
- **No required checks** is an error, not an empty list: exit 1, nothing on stdout, and the message on stderr
  with a newline. A network error also exits 1, so the parser reads `none` only when exit 1, an empty stdout
  and the whole of stderr (trimmed) is gh's message. Anything else with exit 1 and no list is unknown.
- **Pending and failing exit 0 with `--json`.** gh's help gives 8 for pending and 1 for failed. But with
  `--json`, gh 2.83.2 exited 0 for both #245 (`desktop` and `gate` with bucket `pending`, state
  `IN_PROGRESS`) and #242 (`gate` with bucket `fail`, state `FAILURE`). The parser takes 0, 1 and 8 and reads
  the state from the buckets, never from the exit code, so nothing in it changed. A pending entry is
  `{"bucket":"pending","description":"","link":"https://github.com/travistruett/10db/actions/runs/41390916319/job/125101889888","name":"gate","state":"IN_PROGRESS","workflow":"ci"}`.
  A failing one is
  `{"bucket":"fail","description":"","link":"https://github.com/travistruett/10db/actions/runs/41389319225/job/125096990697","name":"gate","state":"FAILURE","workflow":"ci"}`.
  The full lists are `SPIKE_PENDING` and `SPIKE_FAILING` in `ci-checks.test.ts`.
- **A cancelled check exits 0 too.** On #333 GitHub cancelled the required `desktop` check (job
  125201910780, completed and cancelled before any step ran) while the other four passed. gh exited 0, not
  the 1 its docs give, and printed nothing on stderr. The cancelled entry is
  `{"bucket":"cancel","description":"","link":"https://github.com/travistruett/10db/actions/runs/41422731196/job/125201910780","name":"desktop","state":"CANCELLED","workflow":"ci"}`.
  The parser reads bucket `cancel` as its own state, `cancelled`, and already takes exit 0.
  The full list is `SPIKE_CANCELLED` in `ci-checks.test.ts`.

Not observed yet (no pull request was in that state, and none was made to try it):

- **No checks at all.** gh 2.83.2's binary has both `no checks reported on the '%s' branch` and
  `no required checks reported on the '%s' branch`. In gh's source the first comes when the head commit has no
  checks at all, before the filter to `--required`. A base with no CI, or a pull request pushed before GitHub
  lists its runs, gets that message with `--required` too. Both messages are therefore read as `none`.

## `gh run view --job <id> -R <repo> --log-failed`

| Case                   | Exit | stdout                                     | stderr                                                                      | Source   | Read as   |
| ---------------------- | ---- | ------------------------------------------ | --------------------------------------------------------------------------- | -------- | --------- |
| a completed failed job | 0    | the log, `<job>\t<step>\t<timestamp> text` | empty                                                                       | observed | `ready`   |
| a job still running    | 1    | empty                                      | `job <id> is still in progress; logs will be available when it is complete` | observed | `not_yet` |
| signed out             | 4    | empty                                      | as above                                                                    | observed | unknown   |

Observed for job 124622919963 (a failed `desktop` job): **every line's step was `UNKNOWN STEP`**, and gh printed
the whole job's log, from `Current runner version` on, not only the failed step's lines. The first line's
timestamp follows a byte order mark (U+FEFF). For T7: the excerpt (the last 300 lines) still ends at the
failure, but nothing can be cut by step name, and a BOM has to be stripped along with the ANSI codes.

Observed for job 125101889888 (`gate` on #245, status `in_progress` at capture): exit 1, nothing on stdout,
and on stderr exactly `job 125101889888 is still in progress; logs will be available when it is complete`
with a newline. That is the text `RUN_IN_PROGRESS` in `gh.ts` is anchored to, so the regex stays as it is.
It also matches the `run %d …` form in the binary, which was not seen. The fixture is `SPIKE_LOG_IN_PROGRESS`.

## `gh pr merge <url> --auto --squash` with auto-merge already on

Observed on #240, which had auto-merge on, by running the command twice. **Both runs exited 0, with nothing
on stdout or stderr.** Re-arming an armed pull request is a plain success, not an error. `prAutoMerge` resolves
and the fix ship carries on (fixture `SPIKE_REARM_ARMED`). The spec's fallback still holds for any error
GitHub does return: the fix ship treats the pull request as armed and does not raise the refused card (spec
§6). But an already-armed pull request does not go down that path.
