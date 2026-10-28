# A worktree is one more checkout in the lane sandbox

- **Date:** 2026-10-27
- **Amends:** decisions 130, 131 and 132

## Decision

The sandbox gets no new rule. Lanes, gates and MCP servers of a worktree batch get the worktree as their
checkout. The list of registered checkouts that every profile denies writes to gains every live worktree (a
batch whose `worktree_path` is set, whatever its state), and the main checkout of a worktree-mode project is
"another checkout": denied as a whole, with its common git dir opened read-only by the existing linked-worktree
rule. A worktree lane writes only its worktree and its temp dir; its git dir, gitfile and the common dir are
read-only. The worktree root is a lane-writable root for git's config trust checks (`laneRoots`).

## Why

Decisions 130 to 132 already describe a linked worktree's git dir, common dir and gitfile, so a worktree needs
only the right checkout and the right list. A lane in one worktree then can't reach the main checkout or a
sibling worktree.
