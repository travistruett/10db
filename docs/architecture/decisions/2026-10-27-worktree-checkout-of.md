# A workstream works in its batch's checkout, one function says which

- **Date:** 2026-10-27

## Decision

`checkoutOf` (`apps/daemon/src/delivery/checkout.ts`) answers where a workstream works: its batch's
`worktree_path` when set, else `project.repoPath`. Every place that used `project.repoPath` for a workstream
(cwd, guard, file tools, commit, handoff, step-end diff, gate, the session's `.mcp.json`) asks it. MCP
approvals still read the main checkout's `.mcp.json`; a session matches its worktree's servers against them.

Everything runs in the worktree except the push, which runs in the main checkout (`git.push(project.repoPath,
branch)`): refs and config are shared, and the main checkout's pin is the origin the builder trusted. Ship's
branch and clean check, the commit count, the gate, `head` and the PR template read the worktree.

The launch rule lets a workstream of a worktree batch start only when the batch is `OPEN` with `branch` and
`base_sha` set and its worktree exists, is pinned and is on `batch.branch`. A running daemon that finds the
worktree missing waits with one folded card naming the path; a switched one raises the wrong-branch card with
the worktree's path; an unpinned one raises only the trust card. Startup recovery fails an `OPEN` or `SHIPPING`
batch in those states; a `FAILED` one stays as it is, since its card offers Retry.

## Why

One rule in one place beats a conditional at each consumer. The push is unchanged so the origin the builder
trusted at registration remains the only one pushed to.
