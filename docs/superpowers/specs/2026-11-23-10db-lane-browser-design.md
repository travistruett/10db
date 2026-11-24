# 10db lane browser design

Designed, not built. November 23, 2026. Core: it widens what a sandboxed lane can reach.

## Brief

**What changes for you.** Every lane, on every account, gets a browser it can drive against the app it starts
itself: open a page, read it, click, fill, upload a fixture from its own copy, and take screenshots that land on
the task as evidence. Unattended browser QA (AMP-56's workbook import on a private stack) runs to the end without
an Inbox card. Your own browser, cookies, tabs, Aside memory and your running dev stack never come into it.

**What it buys.** Lanes stop failing at "needs a signed-in browser", and recovery stops offering **Run these now**
for a call no follow-up can run (the Aside CLI can't run inside a lane, and must not: `~/.aside` holds your
account and password-manager files). Browser evidence becomes a task record that review, QA and the Linear
reporter can cite.

**What could go wrong, and how we'd know.**

- The browser is a new path from a lane to localhost. It reaches only servers the lane itself runs: a process in
  its own process ledger, or a Docker Compose stack started from its own copy or temp dir. That is checked on every
  connection, never by "whoever asked first". Your stack on 8800, another lane's, 10db's daemon, and anything else
  on the Mac are refused. On a project with "Let lane commands use localhost" off, this is still new reach: the
  lane can browse its own servers, which its own `curl` can't.
- Screenshots go to the lane's model provider, as any image a lane reads does. Pictures today never leave the
  Mac; lane screenshots do, and the setting that says so is the browser itself.
- A page that loads fonts or scripts from a CDN looks degraded, since outside hosts are refused. Each answer
  names the refused hosts.
- The pinned headless Chromium could break on an update. Its live test runs before every pin bump.

**Calls you might disagree with.**

1. The first version reaches no outside host and not the project's app address, so it can't QA your shared stack
   on 8800; a lane starts its own.
2. A lane signs in only through the app's own pages, as a test user it created. 10db runs no dev login for it.
3. Cookies last for one session. A review or QA step signs in again.
4. Aside stays a tool for sessions you are in (chats, takeovers, your own Claude Code). Lanes don't get it.

**What's needed from you.** Approve by replying. Ampsio's settings stay as they are: its private stack runs under
Docker, which it already allows, and its database readbacks go through `docker compose exec`.

## What exists and what is new

Built today, for pictures only (`apps/daemon/src/pictures/AGENTS.md`): the pinned Chrome for Testing headless
shell (`browser-pin.ts`, under the data dir's `tools/`), `browser-host.ts` (launch with `--proxy-server` and
`--proxy-bypass-list=<-loopback>` at the pictures proxy, a process ledger, idle close, one caller at a time),
`app-proxy.ts` with `origin-guard.ts` (a proxy below Chromium that holds every redirect hop), `inContext` in
`playwright-camera.ts` (a fresh context with downloads and service workers blocked) and `ToolImages`
(`mcp/tool-images.ts`). Lanes reach none of it except `report_pages`.

Earlier decisions refuse a browser to Plan and chat sessions
(`decisions/2026-11-03-plan-sees-the-app-through-screenshots-not-a-browser.md`) and refuse a free path on the
app's origin (`decisions/2026-11-10-report-pages-loads-only-a-page-areas-route.md`: a signed-in GET of any path is
a confused deputy). This design keeps both: the lane browser never reaches the app address, the daemon or 10db's
UI, and signs into nothing 10db holds.

New: the lane tools, one browser process and proxy per lane session, the ownership rule, and the evidence records.
The pictures browser, its state and its queue are untouched.

## The tools

Five tools on 10db's own MCP server, which every lane already has (`McpToolName`):

| Tool                 | Input                                                                                   | Answer                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `browser_open`       | `url`; optional `viewport`                                                              | final URL, status, title, the snapshot, refused requests, open pages      |
| `browser_snapshot`   | none                                                                                    | the accessibility snapshot with element refs, cut at a fixed size, saying so |
| `browser_act`        | `ref`; `action` (click, fill, select, check, press); `value` where the action takes one | the new snapshot, navigation, dialogs answered, refused requests          |
| `browser_upload`     | `ref`; `paths` (files in the lane's copy or temp dir)                                    | the new snapshot                                                          |
| `browser_screenshot` | optional `fullPage`, `note`                                                             | the image (`ToolImages`), the screen record's id, and the PNG's path      |

- Each call has a 60 s deadline (Codex's MCP tool timeout is the project's human wait plus five minutes, and
  Claude's the same) and returns its errors as text; a refusal is final and says why. Nothing waits on the builder.
- **Pages.** A popup or new tab becomes the current page, and every answer lists the open pages; the snapshot reads
  the current one. At most four pages; a fifth closes the oldest.
- **Dialogs.** `alert` and `beforeunload` are accepted, `confirm` and `prompt` are dismissed unless the `browser_act`
  call that raised them named `dialog: "accept"`; each is reported in the answer. No dialog leaves a call hanging.
- **Uploads.** The handler checks each path with the file-access rules a lane's Read meets (`sandbox/file-access.ts`,
  deterministic; no judge model runs): a secret file, a path outside the lane's copy, its temp dir or its setup
  reads is refused. Downloads stay blocked.
- Every step may use the tools, review and QA included: they act only on servers the lane runs.

## Reach

**Scheme and host.** A URL is `http:` or `https:`, checked in the tool before `goto` and on every navigation and
request (Playwright's routing aborts the rest, as pictures do). `file:`, `view-source:`, `chrome:`, `filesystem:`,
`javascript:`, `data:` and `blob:` navigations are refused; a page's own `data:` and `blob:` subresources load. The
host, after URL parsing, is exactly `localhost`, `127.0.0.1` or `[::1]`; every other spelling (`0.0.0.0`,
`127.0.0.2`, `[::ffff:127.0.0.1]`, `*.localhost`, a name that resolves to loopback) is refused. The proxy connects
to the checked literal address and never resolves a name.

**Ownership.** A port is the session's while, at the moment of the connection, one of these holds:

- a TCP listener on that port belongs to a pid in the session's process ledger (`sandbox/lane-processes.ts`, which
  already remembers the session's processes by pid and start time), read with `lsof -nP -a -iTCP:<port>
  -sTCP:LISTEN`; or
- the port is published by a running container whose `com.docker.compose.project.working_dir` label is inside the
  session's own copy or its temp dir (`docker ps --filter publish=<port>`, run by the daemon outside the sandbox with
  the project's Docker access; `docker-access.ts`). A working dir inside a registered checkout (the builder's stack
  on 8800 is `~/Projects/ampsio`), or anywhere else, owns nothing. A published port matches whatever address
  Docker bound (`0.0.0.0`, `[::]`, loopback); the browser connects to `127.0.0.1`.

Ownership is by address and port: the proxy connects to the address the owning listener reported (`127.0.0.1` or
`::1`; a wildcard listener or a Docker-published port is reached on `127.0.0.1`). The browser's own pids and its
proxy's never own a port, so a DevTools port can't count as the lane's. Only a Compose stack's ports are owned; a
plain `docker run -p` is refused, and the refusal says to start it with Compose from the copy. `docker ps` runs
with a 5 s timeout, and a Docker that doesn't answer is a refusal that says so.

Always refused, before ownership: the daemon's port (`isDaemonAddress`), the session's own proxy port and every
other proxy's, and `CONNECT` to anything but an owned port. The answer is cached for 5 s per port and checked again
after; a port the lane's server gave up and something else took is refused at the next check. Each check is one
`lsof` and at most one `docker ps`, and a session runs at most 20 checks a minute, so a page probing ports is slowed
and refused, not served. The rule is a pure function beside `proxyAllows`, given the session's reach and the
ledger's and Docker's readings.

Docker on already lets a lane reach the whole host (`sandbox/AGENTS.md`); the browser adds nothing there. With
Docker off, only the ledger rule can own a port, and only when the project lets lane commands bind localhost.

## The browser process

Each lane session that calls a tool gets its own browser process, launched as pictures launch theirs (the pinned
executable, `HOME` and `TMPDIR` only, the renderer sandbox on, `--proxy-server` at its own proxy with
`--proxy-bypass-list=<-loopback>`, so loopback goes through the proxy) and held in the session's own process
ledger, so `endProcesses` ends it with the session. It never shares a process, a proxy or a queue with pictures.
Launch takes a second or two on first use. At most the project's lane cap run at once; one idle for five minutes
closes and is launched again on the next call, with its cookies gone.

| Event                                    | What happens                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| First tool call of a session             | browser and proxy start; a launch that fails answers with why and the session goes on              |
| Call while a call runs                   | waits for it, within its own deadline                                                              |
| Five minutes idle                        | browser closes; the next call starts a fresh one and says cookies were cleared                     |
| Session ends, is stopped or taken over   | browser and proxy closed with the session's processes; a call in flight answers "the session ended" |
| Daemon restart or crash                  | the ledger reap ends the browser; nothing was saved                                                |
| Next session of the task (review, QA)    | a fresh browser; owned ports are read again, so the stack the implement step left up is the new session's only if its processes or its compose dir are the new session's own copy |
| Task cancelled, project archived         | the session ends, as above                                                                         |

The compose rule is what carries a stack across a task's sessions: they share the task's copy, so a stack started
from it stays reachable to the task's later steps, and to no other task. A session's temp dir is its own, so a
stack started from an archive extracted there is not the next session's; the lane prompt says to extract such an
archive under the copy (an ignored folder) when later steps should reuse the stack. A Your-folder task's copy is
the registered checkout, which owns nothing, so its lanes reach only stacks started from their temp dir: the
refusal wins, so the builder's own stack is never a lane's.

## Evidence

`browser_screenshot` writes the PNG through `picture-files.ts` as a task screen of a new kind, `lane`, with the URL
and the agent's note, writes a copy into the session's temp dir and names its path, and records a new
`EvidenceKind.Browser` with the URL, title and screen id. The task drawer shows lane screens where it shows task
screens today, labelled with the note. The reporter brief lists them as it lists screens.

Lane screenshots go to the session's model provider, which amends `pictures/AGENTS.md`'s "no picture is uploaded
or sent to a model" for the `lane` kind only. The build adds a decision file for it.

## Judging, prompt and recovery

- The five tools are 10db's own (`mcp__10db__`), which the fast path allows; their reach is held by the handler and
  the proxy, so no judge call is made and nothing is skipped below a floor.
- The lane prompt gets one short paragraph: what the browser reaches, that it is the only browser a lane has, and
  that the builder's browser CLIs and skills (Aside) don't run in a lane.
- A skipped Bash call whose program can't execute under the lane's profile (its real path is outside the profile's
  reads) is listed as not approvable, cleared by "use 10db's browser, or run it yourself", so **Run these now** is
  offered only for what a follow-up could run.

## Provider parity

The tools are on 10db's MCP server, which Claude lanes (plan, Bedrock, API key) and Codex lanes all get, so every
account gets the same browser. Image content in an MCP result is the one thing that may differ. Claude Code shows
it. Codex passes a result's `content` through as an untyped array (`McpToolCallResult` in `sessions/codex-generated`),
so whether its model sees the image is unverified; the plan checks it first in `test/codex.live.test.ts`, whose fake
Responses server counts the images in each model request. The PNG's path is in every answer, so a Codex lane can
open it with its own `view_image` either way. If the check shows Codex drops MCP images, the prompt tells Codex lanes
to open the path, and a follow-up task tracks Codex's support.

## Tests

Per `.claude/rules/testing.md`, this is core (sandbox reach):

- The reach rule is a pure table in `origin-guard.test.ts`'s style: schemes, host spellings, the daemon's and proxies'
  ports, a ledger-owned listener, another session's listener, a compose dir in the session's copy, in a registered
  checkout and elsewhere, a port that changed owner after the cache, `CONNECT` forms, the check rate.
- One test through the wiring on the real pipeline (`createTestEngine` with a fake browser launch): `browser_open` of a
  loopback server no ledger owns is refused, and one the session's fake process owns is reached.
- The live browser test (`TENDB_LIVE_BROWSER=1`) gains: a session's browser reaches a server its ledger owns through
  its proxy, and is refused a loopback server outside it, with loopback forced through the proxy.
- The core e2e flow that shows task screens extends to one lane screen in the task drawer.
- AMP-56's fresh import is the acceptance run, on Ampsio, through a Codex lane.

## Out of scope

The app address and the builder's stack, dev login and stored cookies, outside hosts, Aside or any builder MCP server
in lanes, a headed or watched browser, video and downloads. Each is a later decision once the first version runs.
