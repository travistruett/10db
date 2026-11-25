# Task 5: notes and specs say what Full access changes

Read the index's Brief and Global Constraints first.

**Files:**
- `apps/daemon/src/sessions/AGENTS.md`: "An unsandboxed session always runs in `default`" becomes true of lanes
  only, citing the new decision. The 2026-10-31 decision record is not edited; the new record amends it.
- `apps/daemon/src/chat/AGENTS.md`: the Full access branch, its verdict and its hold.
- `docs/superpowers/specs/2026-11-17-10db-sessions-simplified-design.md`, section "4.3": one line that a Full
  access chat's shell can write anywhere, and the folder hold is what keeps 10db's writers apart.
- `docs/superpowers/specs/2026-11-12-10db-trust-line-design.md`, the attended policy section: a Full access chat
  is judged by its agent's own checks (Claude) or 10db's judge (Codex), citing the decision.
The decision record is already written.
