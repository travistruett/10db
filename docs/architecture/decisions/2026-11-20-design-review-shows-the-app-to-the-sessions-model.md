# Design review shows the app to the session's model

- **Date:** 2026-11-20
- **Amends:** `decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md` (its
  pictures never go to a model)

## Decision

- Pictures of the builder's app and of a drawn mock-up go to the session's own model in two places only: a
  Design review of a plan, and a lane's `check_design`. Nothing else sends a picture to a model; pass
  pictures still stay on the Mac (or go to a pull request only when `prPictures` is on).
- A Design review copies its PNGs into the plan's folder, which the session and its reviewers already read.
  `check_design` answers the PNGs as image blocks, so a lane reads nothing under the data directory.
- **What leaves the Mac, exactly.** The shots are taken signed in, through the project's dev login, so
  pages that show the builder's signed-in data go to the model, not just public pages. The plan-folder
  copies of a Design review's pictures stay there up to 14 days (`<data>/shapes/<plan>/design/`), and any
  later session of that plan can read them, including one on another provider after an account switch. A
  lane's `check_design` sends its pictures as image blocks in that call's result, within the account's
  picture limits, and they stay in that session's history.
- A mock-up is drawn with JavaScript off, no network and the window's own policy (`MOCKUP_CSP`).
- The pictures and verdict are kept in `design_checks` for 14 days after the task is done, so a later
  step (a pull request, Slack, Linear) reads that row.
- A lane in a worktree can't run `check_design`: nothing serves a worktree's app. The tool says so.

## Why

The builder asked for a design reviewer that sees the app; a model cannot judge a layout it never sees.
The pictures are the builder's own app, sent to the model they already run the session on; the builder who does not want signed-in pages sent leaves the project's dev login command empty, and the shots then show the sign-in page.

## Cost if wrong

A project whose app shows data the builder won't send to its model can't use Design review; the builder
simply doesn't press it, and a lane only gets `check_design` when the builder approved a mock-up.
