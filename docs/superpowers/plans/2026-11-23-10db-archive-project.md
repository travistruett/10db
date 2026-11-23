# Archive Project

## Brief

- **What changes for the builder.** Settings › This Project › General ends with an "Archive Project" card. Archive asks
  first, then the project leaves the switcher, the rail, the Inbox, the Board and every list, and 10db stops all
  its activity. Settings › All Projects › Overview lists archived projects, each with Restore. The repository, its
  branches and pull requests are never touched, and nothing is deleted.
- **What it buys.** Throwaway projects (`retry-proof`) stop being noise, with no risk of losing data.
- **What could go wrong, and how we'd know.** A list or a background job that still reads archived projects shows
  one, or keeps working on it. The e2e flow archives a project and checks the switcher, the Inbox and the Board.
  A refusal that is too broad blocks an idle project. The confirm names what is still running.
- **Calls the builder might disagree with.**
  - It refuses while work runs. Stop the work first.
  - A failed batch doesn't block, because it is never finished on its own.
  - Adding an archived repository again is refused with "Restore it from Settings › Overview".
- **What's needed from the builder.** Nothing. The archive-vs-delete call is made: archive.

**Size:** Feature. It has one forward migration (a nullable column) and nothing is destroyed.

**Provider parity:** nothing here depends on the account's provider. Archive behaves the same on a Claude plan,
Bedrock or API key, and Codex.

## Parts

1. **Store** (`packages/db`): `projects.archived_at` (nullable, the same shape as `chats.archived_at`), generated
   with `pnpm --filter @10db/db generate`, forward-only (`packages/db/AGENTS.md`).
   - `listProjects(db)` leaves out archived projects. `listArchivedProjects(db)` returns them. `getProject` still
     returns an archived project, so old rows and events resolve.
   - `archiveProject(ctx, id)` and `restoreProject(ctx, id)` emit `ProjectChanged`.
   - `ProjectDto` gains `archivedAt: string | null` in contracts.
2. **Refusal** (daemon): archiving throws a typed `ConflictError` naming what runs, when the project has any of:
   - a workstream in `ACTIVE_STATES` (`projectsWithWork` in `accounts/moves.ts` is the template)
   - a pass in `OPEN_PASS_STATES`
   - a batch in Cutting, Open or Shipping
   - a chat with a live session
   - a Slack question Sending or Sent (`projectSlack(...).out`)
3. **Stopping what's left** (daemon), on archive:
   - Stop its preview dev servers.
   - Cancel its pending open (`pass/pending-open.ts` `cancel(projectId)`).
   - Drop its in-memory per-project state where a map would keep acting on it. Sweeps, the scheduler and the PR
     watch iterate `listProjects`, so they drop it by themselves.
   - Check every other `listProjects` caller and every query across projects for the Inbox, Board, Sessions,
     Factory, Knowledge, Accounts and People. Each one must leave archived projects out. The Inbox query is
     the one most likely to miss.
4. **API.**
   - `POST /projects/:projectId/archive` returns 204, or 409 with the refusal.
   - `POST /projects/:projectId/restore` returns 204.
   - `GET /projects/archived`.
   - Creating a project whose `repoPath` is archived is a 409 whose message says to restore it from Settings ›
     Overview. Today the unique constraint fails instead.
5. **Desktop.**
   - In `project-general-form.tsx`, after Running Tasks: a `SettingsCard` "Archive Project" with one line ("Hides
     this project everywhere and stops its activity. Nothing is deleted; restore it from Settings › Overview.")
     and a red-outline Archive button.
   - The button opens a `ConfirmModal` (destructive). A refusal shows in the modal's error.
   - After archiving, the selected project falls back (`shell/selected-project.ts`) and the page lands on the
     Board.
   - Overview gets an "Archived Projects" card, shown only when there are any: one row per project with its
     path and a Restore button.
   - Note it in `views/settings/AGENTS.md`.

## Tests (`.claude/rules/testing.md`)

- **One store test** on real SQLite (`packages/db/src/store/`, `createTestStore` + `seedProject`):
  - Archive leaves the project out of `listProjects` and keeps its rows. Restore brings it back.
  - Its Inbox items are left out of the Inbox list query.
  - This is core data behaviour.
- **One daemon test** through the real API (the `trust-api.test.ts` rung): archive is refused with 409 while a
  workstream is active, and succeeds once it is done.
- **The e2e flow** `first-run.spec.ts` (flow #1, adding a project) is extended: add a second project, archive it
  from General, and check that the switcher no longer lists it. Then restore it from Overview, and check that it
  is listed again.
- No other tests. Each adding commit carries a value card.

## Order

Store and contracts, then the daemon refusal, stops and API, then the desktop. Generate the migration last, after
the final merge of `main`, and only while no other open PR adds one.
