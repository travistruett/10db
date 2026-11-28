# A guest sees a built, sandboxed preview at a commit the builder chose, never the dev server

- **Date:** 2026-11-27

## Decision

Designed, not built. The design is `docs/superpowers/specs/2026-11-27-10db-review-links-design.md` (§5.1, §5.4).

- A review link shows a build of one commit, which the builder picks when making the link. It never proxies the
  project's dev server (`previewCommand`, `appUrl`).
- A project says how with its guest settings: `guestBuildCommand` and `guestStartCommand`, and optionally
  `guestTeardownCommand` and `guestLoginCommand`. A project without the first two can't make a link.
- Each link gets its own git worktree at its commit, under `~/.10db/worktrees/`, and its own server.
- The commands run under the gate's sandbox. The build may use the project's hosts. The server, the teardown
  and the sign-in run with an empty host list and loopback on. A project without Allow loopback can't make a
  link.
- **Docker is the builder's switch, off by default.** `guestDocker` is a setting of its own; the project's Docker
  switch never turns Docker on for a guest run. Turned on, the guest server's egress is no longer confined to
  the Mac, and Settings says so beside the switch.
- **What the build serves is the builder's choice.** 10db neither enforces nor claims fake data, and the dev
  login's fictional-user check doesn't apply to `guestLoginCommand`. Settings says in plain words that anyone
  with the link sees and can change whatever the build serves, signed in as whoever the command names.
- Once the server answers, and every 30 seconds after, 10db reads the listening sockets of the processes it
  started and stops one bound beyond loopback.
- Each link's server stays up while the link is live, at most three on a Mac.
- The guest door, which fronts the server, has no dev-server rules because no dev server is behind it. It
  refuses source maps and dotfile paths as cover for a sloppy start command, and adds a Content-Security-Policy
  to every answer that lets the browser connect only to the preview's own origin and the hosts
  the project lists (`guestBrowserHosts`).
- What the sandbox confines by default: the guest server reaches no host off the Mac; the build and the server
  read no `.env*` file and inherit no secret-named variable; the guest is never the live dev server.
- What it doesn't confine, each stated in Settings rather than refused:
  - loopback, which is all or nothing, so every local server is reachable, the dev database included;
  - anything, once `guestDocker` is on;
  - a key committed in the repository;
  - where a page navigates the guest's browser.
- A guest pick carries no component name and no `file:line`.

## Why

- A dev server serves source files and source maps, runs with the builder's real `.env`, changes as agents edit,
  and usually talks to whatever the builder is working against. A guest would see work in progress and drive
  real calls.
- A build at a commit is what the builder meant to show, and it stays the same while they keep working.
- The sandbox, not the project's good intentions, is what stops a build an agent wrote from calling out. An
  empty host list is already a per-run input of the gate's sandbox, so no sandbox change is needed.
- The sandbox stays the default because it contains what an outside person on the internet can drive, not
  because the builder is distrusted. Sharing their own project, with what data and with or without Docker, is
  the builder's call (`decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`): 10db says
  what each choice opens and doesn't forbid it.
- Docker is off by default, where most of the builder's setup is on by default, because a guest run is new,
  internet-facing exposure and has nothing of the builder's to carry over. Refusing Docker outright was turned
  down: an app whose database runs only in compose could never be previewed.
- Enforcing fake data was turned down: 10db never sees the database, so it could only pretend to, and a check on
  the sign-in command's email would stop a builder showing a partner their own account.
- One command for build and start was turned down: a build may need a registry, and the server must have no
  hosts, so each needs its own list.
- A development-mode build with source maps would give `file:line`, at four times the bundle and with the
  source published to the guest. Selector, text, box, route, viewport and crop are enough for an agent to find
  the code.
