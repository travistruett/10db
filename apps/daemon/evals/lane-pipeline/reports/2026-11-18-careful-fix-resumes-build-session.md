# Careful fixes in its Build session: the eval so far

## Brief

- **What changes for you:** nothing yet. A Careful task sent back by its reviewer fixes in a fresh session that
  sees only the reviewer's notes, as before. A Careful row set to `resumed` in the Playbook already continues in
  the build session with the findings in its prompt; Critical stays fresh.
- **Careful's default: unchanged (fresh).** The keep rule (criteria met the same or better, and no case that
  passed in the baseline fails in both runs) has not been checked against a real model, so the default can't move.
- **Why no real eval:** there is no saved Careful baseline, a real run spends usage, and a 10db lane's sandbox
  can't read the Claude transcripts a real run needs (`apps/daemon/scripts/eval/AGENTS.md`). A fake-agent run
  can't help either: its reviewers always approve, so no task is ever sent back.
- **What this change adds:** `FIX_BY=resumed|fresh` on `make eval`, recorded in the report, and a test that a
  Careful task with a `resumed` row resumes its build session with the findings in the prompt.
- **What is needed from you:** run the real eval from a plain terminal (the follow-up task), on `main` with
  plan-in-Build still off: `make eval RIGOR=careful SAVE_BASELINE=1`, then
  `make eval RIGOR=careful FIX_BY=resumed`. The second report's Keep rule section says whether Careful's default
  may become `resumed`; if it fails, the default stays and the report says why.

## Evidence

- `apps/daemon/src/runner/runner.test.ts`, "resumes the Build session of a Careful task when its row says
  resumed": the fix session resumes the build's provider session, on its model, with the rejection's finding in
  its prompt.
- `apps/daemon/scripts/eval/run.test.ts`: a run with `fixBy` set writes it to the eval daemon's playbook row and
  to the report.
- `apps/daemon/src/routing/playbook.test.ts`: Careful and Critical default to `fresh`.

The decision is `decisions/2026-11-18-careful-fixes-in-its-build-session-only-once-the-eval-holds.md`.
