# Card 8: Linear without linking

**Size:** Feature (a removal plus one Settings row). No plan review of its own; one code review.
**Why:** the builder's call (2026-11-22). Linking a project to a team is friction, and it buys nothing that writing
by Linear's own issue id doesn't already give. One agent account's Linear sign-in reaches one workspace, so the
workspace is the sign-in's. Import filters in words ("my ready AMP issues"). 10db's rule: the builder's setup comes
along by default, and the builder turns things off, not on.
**Track:** B. It starts at once, beside card 4. Card 4 removes the reporter's own workspace check and its tool;
this card removes part 2's link.

## Files

- **Daemon:** remove the link.
  - `apps/daemon/src/linear/bindings.ts`: remove `check`, `submit`, `cancel` and `unlink`, the in-memory checks,
    and the `linear.<projectId>` setting reads and writes. Keep `startImport`, renamed if the module's name no
    longer fits (e.g. `linear/import.ts`). It refuses only on a definite `LinearVia.None` (`refuseSignedOut`) and
    opens the Plan session. Its brief names no team or workspace: "Import Linear issues as tasks. Ask me which
    issues …". Keep the drafting rules, the `external` link shape and blocks→`dependsOn`.
  - `apps/daemon/src/chat/tools.ts` and `packages/contracts/src/chat-tools.ts`: remove `link_linear_team` and its
    input.
  - Routes in `apps/daemon/src/api/app.ts`: remove `POST /projects/:id/integrations/linear/check` and
    `DELETE /projects/:id/integrations/linear`.
  - `GET /projects/:id/integrations` carries `linear: LinearReporterSettings & { blockedBy: string | null }` in
    place of `{ binding, check }`. Add `PUT /projects/:id/integrations/linear` with a `LinearReporterSettings`
    body: off drops the project's pending rows (`dropPendingLinearPosts({ projectId })`) and refreshes the Inbox
    card if card 5's `refreshReporterCard` exists by then.
  - **Contracts:** remove `LinearCheckDto`, `LinearCheckInput`, `LinkLinearTeamInput` and `ProjectLinearDto`.
    Leave `LinearBinding` in place if the reporter's files still import it. The coordinator removes it after card 4
    merges. Regenerate `packages/contracts/generated/`.
  - A stored `linear.<projectId>` setting from part 2 is left unread. Deleting it at startup is optional; nothing
    reads it.
- **Desktop:**
  - `views/settings/sign-ins/project-rows.tsx` `LinearProjectRow`: no team-key field, Link, Unlink or checking
    state.
    - When the project's account reaches Linear, or might (unchecked): a **Report To Linear** switch, and under it
      a **How To Update Linear** textarea that saves on blur. Add the `blockedBy` line, dim, when set (Your MCP
      servers off).
    - When the account definitely has none: the row's hint, as today.
  - `views/settings/sign-ins/linear-card.tsx`: the state line is "10db uses your agent's own Linear sign-in and
    never stores a Linear login. Sign in inside Claude Code (`/mcp`, or the claude.ai Linear connector) or in Codex
    (Settings › Trust)."
  - `views/sessions/from-linear-item.tsx`: shown whenever the project's account reaches Linear or might, not only
    for a linked project. The disabled-with-hint state is unchanged. (Another session edited this file before; it
    has nothing open now.)
  - `daemon/sign-in-queries.ts`: drop the check, link and unlink hooks; add the PUT.
- **Docs:**
  - The spec's "Sign-ins and bindings" Linear row and "Linear binding check": add a short note at the top of the
    spec's Linear parts that the link was removed, pointing at the decision. Leave the rest of the spec text.
  - `apps/daemon/src/linear/AGENTS.md`.
  - A decision record in `docs/architecture/decisions/`, dated 2026-11-22: "Linear needs no link: a project uses
    its account's Linear sign-in". It covers detection per account, issue-id writes pinning the workspace, import
    filtering in words, and Report To Linear on by default.
- **Tests:**
  - Delete the part 2 tests of the link check and `link_linear_team`.
  - If an e2e binds a project (grep `integrations/linear` and `link_linear_team` in `apps/desktop/e2e` and
    `sessions/fake-*`), drop the binding step. Keep the AMP-1 import assertions.
  - Add no tests.

## Done when

The checks in Global Constraints pass. You clicked through the Linear card's rows and the New Session menu against
the real daemon (`make dev` or the `10db-dev-window` skill), with screenshots in your scratch folder named in your
report. `grep -rn "link_linear_team\|LinearCheck\|integrations/linear/check" apps packages` finds nothing.
