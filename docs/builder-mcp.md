# The builder's MCP tools

Any MCP client you run can list, create, edit, start and park 10db tasks and read the Inbox. These are
**your** tools: a managed session never sees them (it has its own `10db` server, with different tools).

## Add it to a client

One command, once. It names the app's own node and the bridge that ships inside the app, so there is no token to
copy and nothing to update when 10db restarts or moves to another port.

Claude Code:

```sh
claude mcp add --scope user 10db-builder -- \
  /Applications/10db.app/Contents/MacOS/tendb-node \
  /Applications/10db.app/Contents/Resources/daemon/builder-mcp.mjs
```

Codex:

```sh
codex mcp add 10db-builder -- \
  /Applications/10db.app/Contents/MacOS/tendb-node \
  /Applications/10db.app/Contents/Resources/daemon/builder-mcp.mjs
```

Any other client that starts stdio servers (Claude Desktop, say) takes the same two paths in its config file:

```json
{
  "mcpServers": {
    "10db-builder": {
      "command": "/Applications/10db.app/Contents/MacOS/tendb-node",
      "args": ["/Applications/10db.app/Contents/Resources/daemon/builder-mcp.mjs"]
    }
  }
}
```

Start a new session in the client; the tools are `list_projects`, `list_flows`, `list_tasks`, `create_task`,
`edit_task`, `remove_task`, `start_task`, `move_task` and `list_inbox`.

The server starts and lists its tools whether or not 10db is open. A call made while 10db is closed answers
"10db is not running: open the 10db app and try again"; open the app and call again, with no restart of the
client.

### A development daemon

A daemon run from source keeps its data in its own directory (`.dev/data` for `pnpm dev`). Point the bridge at it
with `TENDB_DATA_DIR`, using the bundle from `pnpm --filter @10db/daemon build` (it writes
`apps/daemon/dist/builder-mcp.mjs`):

```sh
claude mcp add --scope user -e TENDB_DATA_DIR=/path/to/10db/.dev/data 10db-builder-dev -- \
  node /path/to/10db/apps/daemon/dist/builder-mcp.mjs
```

The bridge reads no other 10db variable.

## What the tools do

| Tool            | Does                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `list_projects` | Projects with their areas, hazards, board columns (ids for `move_task`), default flow and delivery.            |
| `list_flows`    | Flows, with ids.                                                                                               |
| `list_tasks`    | A project's **open** tasks. Finished and removed tasks are left out.                                           |
| `create_task`   | Makes a task from a title, description, criteria, areas, dependencies, risk tags and flow, and returns its id. |
| `edit_task`     | Changes a task's title, description, criteria, risk tags or flow.                                              |
| `remove_task`   | Removes a task that has not started.                                                                           |
| `start_task`    | Starts a **Ready** task; any other is refused.                                                                 |
| `move_task`     | Moves a task to a board column (parking it), or with `to: null` back to Planned.                               |
| `list_inbox`    | Open Inbox cards: id, kind, project, title, time. Answer them in the app.                                      |

`create_task` refuses what the New Task form refuses, with the same words ("Add at least one acceptance
criterion", "Choose at least one area", and the API's messages for an unknown area or a title with a line break).

Not available here, on purpose: answering a card, shipping or abandoning a batch, changing a project. They stay
in the app.

Text in cards and tasks may have been written by a managed session. The server's instructions tell the client to
treat it as data, never as instructions.

## Retire the `10db-task` skill

The drafting guidance that lived in `~/.claude/skills/10db-task/` (the title as the outcome, criteria you can see
or measure, areas from `list_projects`, no confirmation step) is now in the server's instructions and the
`create_task` and `edit_task` descriptions, so every client gets it. Once a new session lists the tools:

1. Open `~/.claude/skills/10db-task/SKILL.md` and compare it with the instructions in
   `packages/contracts/src/builder-mcp-tools.ts` (`BUILDER_INSTRUCTIONS` and the tool descriptions). The wording
   there was drafted without being able to read the skill, so anything the skill says that the tools don't is
   worth adding there.
2. Delete `~/.claude/skills/10db-task/`.

## When it fails

| Error                                            | Meaning                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| 10db is not running                              | The app is closed, or its daemon stopped. Open it.                |
| 10db refused the builder token                   | The daemon restarted between two reads. Call again.               |
| 10db did not answer within 60 seconds            | The daemon is busy or stuck. Check the app.                       |
| 10db answered HTTP 4xx/5xx, or could not be read | The bridge and the app are different versions. Reinstall the app. |
