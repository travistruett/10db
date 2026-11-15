# 10db-task

A user-level agent skill: in any session, say "create a task for this in 10db" and Claude
drafts the task (title, description, measurable acceptance criteria, areas, dependencies, and kinds or rigor only when the user names them),
posts it to the running 10db app and reports what it made. A wrong task is edited or removed. Say
"dry run" to see the draft and the validated request without creating anything. It can also edit,
remove (while unstarted) and start tasks.

10db installs this skill into `~/.10db/skills/10db-task` and links it for Claude Code and Codex. The builder MCP bridge
(`docs/builder-mcp.md`) is a separate channel, not a replacement for it.

## Files

- `SKILL.md`: what Claude follows.
- `tendb.mjs`: the API client, built from `packages/agent-skill/src` (Node 22+, no dependencies). Commands are `context`, `project` (reads only), `areas`,
  `create [--dry-run]`, `edit [--dry-run]`, `remove`, `start`, `hazards [--dry-run]` (add-only) and
  more; the file header lists them all.

## How it reaches the app

The app writes `~/Library/Application Support/10db/daemon.json` (port) and `ui-token` (bearer
token) when its daemon starts. `tendb.mjs` reads both, uses the token only in the `Authorization`
header and never prints it. It calls `GET /projects`, `GET /kinds`, `GET /accounts`, `GET /projects/:id/tasks`,
`POST /projects/:id/tasks`, `PATCH /tasks/:id`, `POST /tasks/:id/remove` and `POST /tasks/:id/start`.

A project matches the session when the session's repo, or the main checkout behind a git worktree,
is the project's `repoPath`.

## Validation

`create` checks the draft against `TaskInput` in `packages/contracts/src/entities.ts` and against the
live project before posting: title of 1–200 characters on one line, at least one non-empty criterion
with no newlines, areas from the project's list, `dependsOn` ids that exist in the project, known
kinds and rigor, and no unknown fields. The daemon validates again on `POST`. `TaskInput` and `TaskPatch` are the contracts' own schemas, so
they change with the app. `edit` checks a patch against `TaskPatch` the same way.

## Testing

`packages/agent-skill/src` has table tests over a fake API for every command, and the daemon's tests run the
built skill against the real API.
