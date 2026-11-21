# Plan in Sessions, slice 5: Design review

Spec: `docs/superpowers/specs/2026-11-19-10db-plan-in-sessions-design.md` §4 (Design review), §9. The code facts
behind this page were gathered on 2026-11-20 from `main` at `490466f2`.

## Brief

- **What changes for the builder:**
  1. **At plan time,** Review ▾ gets **Design review**. For each pending task with a mock-up and a page area,
     10db draws the mock-up to a PNG and takes fresh shots of the page as it is now, starting the preview
     when nothing answers. A design reviewer then compares the mock-up with those shots and with the
     project's `DESIGN.md`. Its findings land on the row and in the conversation, as the other reviews' do.
  2. **After building,** a lane whose task has an approved mock-up gets a `check_design` tool. The tool shoots
     the task's page now, puts the shot beside the mock-up's PNG, and hands the agent both. The lane brief tells
     the agent to run the tool before it hands off and to fix what doesn't match. Every check is kept, and the
     task's drawer shows the newest one as mock-up | app side by side.
- **What it buys:** a UI task comes back looking like what you approved. The mock-up, the shot and the verdict
  are kept together (one `design_checks` row), so attaching them to the PR, Slack or Linear later only reads
  that row. A Figma-edited design (`tsk_01a1fc3f…`) becomes one more kind of design target.
- **What could go wrong, and how we'd know:**
  - Shots are slow. They run one at a time through the existing pictures browser: one viewport and theme by
    default, the mock-up PNG cached by its hash, 90 s per shot at most. The panel says "Taking pictures"
    until the review turn starts.
  - A page needs sign-in. The project's dev login runs, as it does for pass pictures.
  - No app address, or the preview won't start. The review runs on the mock-up and `DESIGN.md` alone and says
    which evidence was missing.
- **Calls you might disagree with:**
  - Pictures of your app now go to the session's model, for Design review and `check_design` only. This
    amends the stay-on-the-Mac decision and gets its own decision file.
  - A worktree lane can't run `check_design`, because nothing serves a worktree's app. The tool says so, and
    a Board task follows. Pass lanes, which share the checkout the preview serves, can.
  - A lane's mismatch is fixed by the lane itself during its run. 10db sends it nothing: the "offered, never
    sent" rule stands.
  - Design review uses the approved mock-up, and a task with none uses its newest mock-up.
- **Needed from you:** nothing.

## Size

Feature, with a sandbox-adjacent piece (drawing mock-up HTML in the pinned browser), which gets one test.
One implementer works end to end in its own worktree off `feat/plan-in-sessions-s5` and merges back. One
review follows, spent on the camera and the preview hold. The one migration of slice 5 (`design_checks`) is
generated last, after the final merge of `main`.

## Provider parity

| | Claude (plan, Bedrock, API key) | Codex |
| --- | --- | --- |
| Design review | a `tendb-design` subagent Reads the PNGs and `DESIGN.md` | in the session: the note names the PNG paths, which `view_image` reads (PNG is supported), and says it ran without a separate reviewer |
| `check_design` | the tool's result carries the PNGs as image blocks (a lane reads nothing under the data directory), within the account's picture limits, with `DESIGN.md`'s path | the same image blocks |

## Parts

1. **Pictures of a mock-up and of a page, on demand** (`apps/daemon/src/pictures/`).
   - `PageCamera` gains `drawHtml({ html, viewport, theme, signal })`. It runs in a context with JavaScript
     off, no proxy reach and every request refused, and uses `setContent` with the desktop's `MOCKUP_CSP`
     prepended (`views/sessions/plan/attachments/safe-render.ts`; move the constant to `@10db/contracts`
     so both sides read one copy).
   - `Pictures` gains `shootNow({ projectId, routes, purpose })` → `{ shots, missing }`. It takes the first
     viewport and theme of the matrix and the project's app address, signs in with the dev login, and goes
     through the host's one-at-a-time `use`.
   - Files go through `picture-files.ts` (content-addressed `<data>/screens/…`). The mock-up PNG is cached by
     sha256 of html, viewport and theme.
   - The test is one live-browser case beside `browser.live.test.ts` (behind `TENDB_LIVE_BROWSER=1`): a
     mock-up holding an `<img src="https://…">` and a `<script>` draws with neither loaded nor run.
2. **The preview, held on demand** (`apps/daemon/src/preview/preview.ts`). `reconcile` runs the preview while
   a pass is open **or** a hold is live. `hold(projectId, ms)` keeps it for 5 minutes past the last ask. A hold
   with no pass keeps its notices on the conversation's transcript instead of a pass header, as one line.
   `shootNow` holds, waits for the app to answer (the existing probe, with a 60 s deadline), then shoots.
3. **The record** (`packages/db`: `design_checks`):
   - columns: `id`, `project_id`, `shape_id` (nullable), `task_id` (nullable), `attachment_id`, `purpose`
     (`plan_review` | `lane_check`), `mockup_sha256`, `shots` (json: route, viewport, theme, sha256, or the
     reason it is missing), `design_md_path` (nullable), `verdict` (nullable text), `created_at`;
   - an index on (`task_id`, `created_at`);
   - pruning follows `task_screens`' 14-day rule (`prune.ts`).
4. **Design review at plan time** (the §1 list in the facts file, mirrored on `review`):
   - `ShapeReviewer` and `ShapeFindingReviewer` get `design`; `ShapeMessageKind` and `ShapeEventKind` get
     `DesignReview`; `ReviewTurnKind` gets `DesignReview`, with `stampReview` allowing `design`;
   - `PLAN_REVIEWERS` and `SHAPE_AGENTS` get `tendb-design`, whose prompt covers layout, hierarchy, tokens
     and components against `DESIGN.md`, consistency with the app now, and mock-up gaps a builder would
     hit;
   - `POST /shapes/:id/design-review`; the desktop menu item Design review;
   - the service takes pictures first and queues the note only after it has them, with the PNG paths, the
     `DESIGN.md` path (the checkout's root `DESIGN.md`, or none) and what is missing. One `design_checks`
     row is written per task.
   - "Nothing to review" when no pending task has both a mock-up and a page area.
5. **`check_design` in a lane** (lane MCP tools, `apps/daemon/src/mcp/`; brief text in
   `briefing/plan-context-text.ts`):
   - it is offered only when the task has an approved mock-up;
   - it shoots the routes of the task's page areas, draws the mock-up, writes a `lane_check` row, and returns
     the two PNG paths per route plus `DESIGN.md`'s path;
   - a worktree lane gets "this task runs in a worktree, where 10db serves no app; compare by reading the
     mock-up's HTML";
   - `renderMockups`' line says to run `check_design` before handing off, fix what differs, and say in the
     handoff what still differs; the agent's own summary of the comparison becomes `verdict` (an optional
     `verdict` argument on a second call).
6. **Desktop:** the task drawer's Plan context shows the newest `design_checks` row of the task (mock-up |
   app, per route, the verdict under them) through `GET /tasks/:taskId/design-checks`, classified in
   `render-access.ts` as refused to screens, like `GET /tasks/:taskId/screens`.
7. **Decision and docs:**
   - `docs/architecture/decisions/2026-11-20-design-review-shows-the-app-to-the-sessions-model.md` amends
     `2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md`: Design review and
     `check_design` send their PNGs to the session's own model; nothing else does;
   - update the notes in `pictures/AGENTS.md`, `preview/AGENTS.md`, `shape/AGENTS.md` and
     `views/sessions/plan/AGENTS.md`, and spec §4's row: Built.
8. **Follow-up on the Board:** a worktree lane serves its own app (a preview per worktree on a free port), so
   `check_design` works there too.

## Tests

- The live-browser case in part 1, the sandbox-adjacent piece. It is never run in CI.
- `confinement.test.ts` / `policy.test.ts`: extend the reviewer-stamp case with `tendb-design` (trust
  surface, spec §10). No new file.
- `e2e/sessions.spec.ts`: Design review on a plan with a mock-up through the fake camera
  (`test/fake-camera.ts`), so its finding lands on the row. No e2e for `check_design` (its shot is the
  same `shootNow`).
