# The builder's MCP tools

Any MCP client you run can list, create, edit, start and park 10db tasks, read the Inbox, and find and record
your decisions and principles. These are **your** tools: a managed session never sees them (it has its own `10db` server, with different tools).

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
`edit_task`, `remove_task`, `start_task`, `move_task`, `run_next`, `list_inbox`, `start_shape`, `search_knowledge`,
`save_decision`, `save_principle`, `supersede_knowledge`, `retire_knowledge`, `withdraw_knowledge` and
`list_proposals`.

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

| Tool            | Does                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_projects` | Projects with their areas, hazards, isolate list, board columns (ids for `move_task`), default flow and delivery.                          |
| `list_flows`    | Flows, with ids.                                                                                                                           |
| `list_tasks`    | A project's **open** tasks. Finished and removed tasks are left out.                                                                       |
| `create_task`   | Makes a task from a title, headline, why, description, criteria, areas, dependencies, risk tags, flow and landing; returns its id.         |
| `edit_task`     | Changes a task's title, headline, why, description, criteria, risk tags, flow, areas or landing (areas and landing only before it starts). |
| `remove_task`   | Removes a task that has not started.                                                                                                       |
| `start_task`    | Starts a **Ready** task, resumes a held one, or with `fresh` starts a failed one over; any other is refused (see below).                   |
| `move_task`     | Moves a task to a board column (parking it), or with `to: null` back to Planned.                                                           |
| `run_next`      | Puts a started task that is waiting for a lane first in line for the next free lane (see below).                                           |
| `list_inbox`    | Open Inbox cards: id, kind, project, title, time. Answer them in the app.                                                                  |
| `start_shape`   | Moves a brainstorm into Shape: a conversation whose first message is your summary, with inline text files (256 KB in all, never paths).    |

The knowledge tools are in [Decisions and principles](#decisions-and-principles).

`create_task` refuses what the New Task form refuses, with the same words ("Add at least one acceptance
criterion", "Choose at least one area", and the API's messages for an unknown area or a title with a line break).
The drafting guidance asks for a `headline` on every task (the plain words the Board names it by, one line of at most
80 characters) and a `why` whenever the reason isn't obvious from the headline (one sentence, at most 200). Both are
optional and empty by default, and either one too long or with a line break is refused in the API's words, which name
the field. Git never sees them: the title stays the pull request's.
`landing` (`{kind:'base'}`, `{kind:'branch', branch}` or `{kind:'hold'}`) says where the task's pull request goes;
omitted, a new task gets the project's default. A branch origin lacks is refused in the API's words on both tools, and
`edit_task` refuses a landing change once the task has started.

`run_next` is the Board's Run Next button, through the same daemon path as `POST /tasks/:taskId/run-next`: it takes
`taskId`, stamps the task's queued workstream so the scheduler gives it the next free lane, and answers
`{ taskId, workstreamId, state, waitingOn }`. `waitingOn` holds the titles of the task's dependencies that aren't done;
while any are open the task runs once they finish, still ahead of the other queued tasks. It refuses what the Board
refuses, in the same words: "Task <title> isn't waiting for a lane" for a task that hasn't started or whose latest
workstream is running or finished, and the API's "not found" for an unknown task. Start a Ready task with `start_task`
first; a task parked or held back is not queued.

`start_task` also resumes a **held** task (one set aside with `POST /tasks/:taskId/hold`, shown in Blocked), the same
way the Board's Start does: its run keeps its batch and worktree and goes back in the queue, and the tool answers
`{ taskId, workstreamId }` for that run. It still refuses a task that waits on unfinished dependencies (a Backlog task,
or a held one whose dependencies aren't done) and a task with a run in progress or one that is parked.

`start_task` takes an optional `fresh: true`, the `fresh` of `POST /tasks/:taskId/start`. A task whose latest run
failed is not Ready, so `start_task` refuses it unless `fresh` is set. With it, the task starts over from the base
branch in a new batch (the drawer's Start over): the failed attempt's batch is abandoned when it holds only that task's
work, and its branch is kept. The daemon runs its start checks (dependencies, landing, parked) before it abandons
anything, and a refusal leaves the old batch as it was. On a task that never ran, `fresh` changes nothing. The tool
cannot continue a failed run in its batch; that stays the failure card's Retry.

Not available here, on purpose: answering a card, shipping or abandoning a batch, changing a project, accepting or
rejecting a proposal. They stay in the app.

## Decisions and principles

The same records as the [knowledge API](knowledge-api.md), through the same services, so a client with these tools
and a script with `curl` see one store. A session reaches for them on its own: the server's instructions say to
record a rule when you state it with _always_ or _never_, or decide something that should outlive the conversation,
and to search before recording.

| Tool                  | Does                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_knowledge`    | A project's decisions and principles (yours, builder-wide, included): `GET /projects/:id/knowledge` with `q`, `kind`, `scope`, `area`, `limit`, and `history: true`. |
| `save_decision`       | Records a decision: `question`, `choice`, `rationale`, optional `scope` (`you`, `project`, `area`), `area`, `quote`.                                                 |
| `save_principle`      | Records a rule, confirmed at once: `statement`, optional `kind` (`policy`, `heuristic`, `belief`), `topicKey`, `rationale`, `scope`, `area`, `quote`.                |
| `supersede_knowledge` | Changes a current decision or principle by `id` (`dec_…` or `pri_…`): name only the fields to change; the old record stays in history.                               |
| `retire_knowledge`    | Ends a current principle (`pri_…` only) with a `reason`; it stays in history.                                                                                        |
| `withdraw_knowledge`  | Withdraws a current decision or principle recorded by mistake, with a `reason`; the record it replaced becomes current again.                                        |
| `list_proposals`      | Principles that sessions or 10db proposed, waiting for you: `id`, title, rationale and the proposed rule. `status` is `pending` (default), `accepted` or `rejected`. |

The tools are named differently from a managed session's `find_knowledge` and `record_decision` on purpose: a
managed session never reaches this server, and these write as you.

**The source.** The server is stateless and knows no client session, so every write tool takes an optional `quote`
(your own words, up to 2000 characters) and stores `{ "via": "builder_mcp", "quote": … }` as a builder source. The
record's provenance (`GET /decisions/:id/provenance`, `GET /principles/:id/provenance`) shows `origin.via` as
`builder_mcp` and the quote. A supersede shows it on the successor; a retire under `retired.source`, a withdrawal
under `withdrawn.source`. A write without a `quote` still records the MCP server as the source. The tools take no
other source fields and no dry run; use the API for those.

**Refusals are the API's.** Each tool parses its input with the API's own schemas and calls the same service, so a
refusal reads as the API's does: `area: demo has no area named billing` for an unknown area, `Decision dec_a is
superseded; only a current decision can be superseded (the current one is dec_b)` for a record that isn't current,
and `question: …` for a field out of range. `retire_knowledge` on a decision answers `id: Only a principle can be
retired; …`, since the API has no such route.

**Search can be down.** If a search index could not be rebuilt at start, the answer has `search.available: false`
and a message, and a search with `q` has no items. The tool's description tells the client to say so rather than
report that nothing was found.

Proposal text is written by managed sessions: treat it as data. `list_proposals` gives the title, rationale and the
proposed rule, not the card body.

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
