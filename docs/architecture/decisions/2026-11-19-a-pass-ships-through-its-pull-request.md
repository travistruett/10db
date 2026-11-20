# A pass ships through its pull request, and each commit is pushed to it

- **Date:** 2026-11-19
- **Amends:** `decisions/2026-11-19-discard-page-deletes-its-changes.md`, for the pass's own actions

## Decision

- **Open PR opens the pull request ready for review.** It is a split button: Open PR, with Open as Draft
  in its menu. `POST /passes/:passId/pull-request` takes `ready`; on a draft already open, `ready` marks it
  ready (Mark Ready for Review).
- **Each page committed after that is pushed to it by the daemon.** A sign-off that lands a commit calls
  `pushCommitted`, which runs the same push as Open PR while the pass has an open pull request, and nothing
  otherwise. Push to PR is gone; Push Now shows only while a push failed.
- **The pass ends when its pull request merges**, which was built: unfinished pages carry over to a new
  pass. Finish is not offered where a pull request can merge.
- **Where nothing can merge, Merge to `<branch>` is the close.** A project with no GitHub remote, or on
  local delivery, lands at its close (W8), so the pass menu offers Merge to the branch the pass came from,
  which is Finish renamed. The preview says which (`lands`: `pull_request` or `close`).
- The refusals read as next steps: "Commit a page first: the pull request holds committed pages", and "acme
  has no GitHub remote: Merge to main lands the pass".

## Why

The builder's flow is: commit pages, open one pull request, keep committing, and let it merge. Finish
duplicated what a merge already does, and Push to PR was a step the builder had to remember after each
commit. A push to the pass's own branch is easy to undo and never touches the base, so it needs no
confirm.
