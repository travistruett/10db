# A worktree is cut fresh and never refreshed

- **Date:** 2026-10-27

## Decision

A worktree batch is cut from a fetched `origin/<base>` and never rebased or merged with the base afterwards. A
pull request that conflicts is the builder's to resolve, as in shared mode. Retry of a `FAILED` batch rebuilds
a missing worktree from the existing branch, not from a new base.

## Why

Claude Code, Codex and Conductor don't rebase automatically either, and rebasing an unmerged pull request is
already an open item.
