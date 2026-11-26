# A copy's pictures come from its own app, through a command the project supplies

- **Date:** 2026-11-25

## Decision

A project whose separate copies serve an app of their own sets a **Copy App Command** (`copyAppCommand`,
Settings › General under Teardown Command). 10db runs it in the copy's folder under the gate's sandbox with
`TENDB_COPY_ID`; it starts the copy's app when it is not running and prints its address last, a loopback origin
that is neither the daemon's port nor the project's own App Address. It must be safe to repeat, and the project's
Teardown Command stops the app.

With the command set, every picture of a copy task but its before (its after once its workstream is done, a pass
turn's, and `check_design`'s shots) is taken at that address before the copy lands. The dev login then runs in the
copy's folder with `TENDB_COPY_ID` and `TENDB_APP_URL` set, so it signs in to the copy's database, and its storage
state is kept per copy. Every dev login gets `TENDB_APP_URL`, the address being photographed. A copy task keeps
one after. A command that fails, or prints no such address, logs a warning, and the after is taken in the shared
app once the copy ships, as without the command. Befores stay on the shared app: they show the page as the task
found it.

## Why

A copy's afters were taken only after it landed, in the shared app, so a copy's work was never seen before it
landed and its dev login signed in to the shared database. 10db can't derive a copy's address from its id: the
port is the project's choice, and a copy's app may not be up at all. A command the project owns can start it and
say where it answers, the same way the Teardown Command owns the copy's databases. A URL template was turned down
for that reason. A project with no such command loses nothing: its pictures stay as they were.
