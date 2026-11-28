# 10db review links: a partner marks up a built preview from a secret link, and the notes land in the Inbox

**Status:** 2026-11-27; designed, nothing built. **Sizes:** M1 Core, M2 Core, M3 Core (cut for now). It builds on
the remote-host spec (`2026-11-25-10db-remote-host-design.md`) and the Pick on Page spec
(`2026-11-25-10db-pick-on-page-design.md`) and restates neither. Research, outside the repo, in
`~/Agents/notes/10db/`: `2026-11-27-review-links-research.md`, `2026-11-27-review-links-picker-spike.md` and
`2026-11-27-review-links-first-principles.md`.

## Brief

**What changes for you.** In a Workbench page, **Share for Review…** takes a commit, a route, a name ("Mark") and
an expiry (7 days unless you change it). 10db builds that commit as a guest preview and gives you a link like
`https://r-7f3k.10db.app/<secret>` to send. Settings lists your links, each with Revoke. Separately (M1), your own
pages open from the laptop and the phone over your tailnet, with the same "Mark up" pill in a plain browser tab.

**What changes for Mark.** He opens the link in any browser, with no install, account or sign-in. He sees the guest
build you wrote, with whatever data it serves, clicks the pill, clicks what he means, types a note and presses
**Send**. That is all he can do.

**What it buys.** One Inbox card per link, "Mark left 4 notes on /settings", each note with the element's text, its
selector and a crop, and **Make Task**, **Open in Workbench** and **Dismiss**. Nothing he writes reaches an agent
until you press one of the first two, and then it goes fenced as data.

**What could go wrong, and how we'd know.**

- **The internet can reach one small process on the Studio,** the guest door. It is not the daemon: it holds no
  token and no database, and runs in the kernel sandbox. It serves the preview and writes notes to a folder the
  daemon reads. If the sandbox can't take it (unverified; M2's first card), it runs as a plain child process.
- **Anyone holding the link sees the preview** until it expires or you revoke it. Cloudflare ends the TLS
  connection, so Cloudflare can read the traffic, the secret included.
- **Mark sees and changes whatever your guest build serves,** and the sandbox around it has two gaps that Settings
  states in plain words (calls 4 and 5).
- **Mark's notes are untrusted text.** He can send only text, about 64 KB. It is shown as plain text, never
  logged, and never read by a model until you act on the card.
- **The Studio is off.** Mark gets Cloudflare's error page. M3 would fix that; it is cut.

**Calls you might disagree with** (each with its cost if wrong).

1. **No Cloudflare Access.** The link's secret is the only lock, with a 7-day expiry and Revoke. Cost: a forwarded
   link works for whoever has it. An email code can be added later with no redesign.
2. **A guest pick has no `file:line` and no component name;** a built app has neither. Cost: the agent finds the
   code from the selector, text, route and crop.
3. **The Studio takes the crops, not Mark's browser** (your choice). 10db's headless browser loads the pick's
   route and crops the element. Cost: the crop shows the page as freshly loaded, not the dialog Mark had open, and
   a note whose element can't be found arrives with its text and no crop.
4. **Fake or real data is your call, not 10db's** (your amendment). Cost: a guest build pointed at real data shows
   it, and lets it be changed, by whoever holds the link.
5. **Docker is off for a guest preview until you turn it on for that project** (your amendment). Cost with it off:
   an app whose database runs in compose fails its first link. Cost with it on: code a stranger can drive reaches
   any host. Loopback is the other gap: the guest server reaches every local server, your dev database included.
6. **Each link gets its own hostname,** so the one-time Cloudflare setup has a wildcard, `*.10db.app`, in it. Cost:
   any unused name under `10db.app` reaches the door (which answers "This link has ended"), and a link's id shows
   in DNS. Previews still move to their own domain before M3 or before anything on `10db.app` has a sign-in.
7. **Any of your own 10db clients makes a link** (your ruling): the host's window or a paired device. No lane or
   10db-run session can. Cost: a stolen paired device can make links, as it can already do anything else.

**Needed from you:** a reply to this brief. In M2: five minutes in Cloudflare's dashboard, a guest mode for the
first project you share, and a look at the mock-ups before they are built on.

---

The rest is for agents.

## Builder's cut

| #   | Milestone                                                                                              | Size | Rough code   | Cut                                      |
| --- | ------------------------------------------------------------------------------------------------------ | ---- | ------------ | ---------------------------------------- |
| M1  | **Pages over the tailnet:** a preview listener, a proxy to the dev server, picks from a browser tab    | Core | ~1,600 lines | needed; after the Studio goal            |
| M2  | **Guest links:** the guest door, links, the guest build, the tunnel, the feedback card, re-shot crops  | Core | ~3,500 lines | needed; independent of M1, may ship first |
| M3  | A Cloudflare Worker and Durable Object relay in front of the same door and outbox                      | Core | ~3,000 lines | later; cut                               |

M1 is remote-host slice 5 without Copy SSH command. M1 and M2 share two things only: the picker's browser build
(§3.2) and the pick schema (§6). They share no proxy, listener or credential, so either ships first. Each plan is
cut from its own sections: M1 from §2–§4, M2 from §5. Line counts are estimates, with tests.

## 1. Decisions

| #   | Decision                                                                                                                                                                              | Why                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | **M1: the builder's own devices reach a dev server through a reverse proxy in the daemon,** on a preview listener that is its own Hono app with no API routes mounted.                 | Vite and Next refuse an unknown `Host`. Attached to the API's app, a new listener would be treated as Main (`api/credential.ts`, `listenerOf`).      |
| L2  | **M2: the guest door is its own small process.** The daemon starts it under the kernel sandbox. It holds no token and no database, and the daemon handles no request from the internet. | "Routes no API" is then a fact about a process, not a table to keep right. Guest traffic can't stall the loop that runs lanes.                      |
| L3  | **The daemon pulls.** The door writes each Send to an outbox folder; the daemon reads it, parses it with zod and makes the card. The daemon tells the door things through a file.     | One direction each way, both files. The same sentence holds when the outbox is a relay's (M3).                                                      |
| L4  | **Guests arrive by a Cloudflare named tunnel,** never Tailscale Funnel, at one hostname per link, `r-<id>.10db.app`. The builder's own access stays tailnet-only.                     | `decisions/2026-11-27-guests-reach-a-studio-over-a-cloudflare-tunnel-on-a-listener-that-routes-no-api.md`. The browser keeps links apart by origin. |
| L5  | **A guest sees a build of one commit, from its own worktree, under the gate's sandbox with no hosts by default.** What it serves, and whether Docker is on, are the builder's calls.  | `decisions/2026-11-27-a-guest-sees-a-built-sandboxed-preview-never-the-dev-server.md`                                                                 |
| L6  | **Guest input is untrusted text.** It reaches an agent only when the builder presses Make Task or Open in Workbench, fenced. Crops are the Studio's own pictures.                     | `decisions/2026-11-27-guest-input-is-untrusted-data-and-reaches-an-agent-only-by-the-builders-act.md`                                                 |
| L7  | **Only the builder's own clients create, extend, rebuild, list or revoke a link:** the UI token on the host, or a paired device's token. No lane or 10db-run session can, and no MCP tool, lane route or builder-bridge tool exists for links. | Publishing a project is "sending data out" (§7). A device token already has the full API (remote-host R5). The builder's own Claude Code session holds the UI token through the agent skill and is the builder's. |
| L8  | **Link secrets are stored as SHA-256 only,** compared in constant time. The door is handed hashes.                                                                                    | A copied database or door table gives no working link. M3 syncs hashes, never secrets.                                                              |

**Smaller calls,** each the spec's own and cheap to change:

- The builder makes the tunnel by hand once and pastes a run-only token; 10db never holds a Cloudflare API token
  (§5.5). Cost: 10db can detect a wrong mapping, not fix it.
- A guest mode is written per project (§5.4). Cost: a project can't be shared until it has one.
- A link is shown once, because only its hash is kept; **New Link** on a row makes a fresh secret and ends the old.
- A second Send from one link adds to its open card (§5.7).
- A guest preview stays running while its link is live; at most 3 on a Mac. No sleep and wake.
- Over the tailnet (M1), a browser tab's picks carry no crop; the Preview window's keep theirs.

**What this reverses or amends.**

- **Remote-host R2, "Never Funnel".** The words stand. Its reason, recorded in
  `decisions/2026-11-25-a-shared-mac-answers-on-its-tailnet-address.md` as "the tailnet is the only reach", is
  amended: one process 10db starts, the guest door, is reachable from the internet through the tunnel. The daemon
  still is not.
- **Pick on Page §5, "No daemon route takes a pick. No localhost port is opened."** M1 adds one route, for the
  builder's own paired devices (§3.3). M2 adds none: the daemon reads a guest's picks from a file.
- **Pick on Page call 2** (picks arrive as you make them) holds for the Preview window only; the browser picker
  sends on Send.
- **Pick on Page call 4** (the dev login's cookies never cross HTTP). Over the tailnet the preview listener sets
  them, over HTTPS, in a paired device's browser (§2.2).

## 2. M1: the preview listener and its sessions

### 2.1 The listener

- `Listener.Preview`: a `serve()` on `127.0.0.1:<preview port>` (default 4320) **with its own Hono app**
  (`apps/daemon/src/preview-listener/`). That app mounts a Host guard, an Origin guard, the session check, the
  `/__10db/*` routes below and the proxy, and nothing from `api/`. No bearer token is read.
- Only `/__10db/*` is 10db's. Every other path, an app's own `/health`, `/app/*`, `/mcp` or `/events/*` included,
  goes to the proxy. An unknown `/__10db/*` path answers 404 and is never forwarded.
- It starts and stops with sharing and is mapped by `tailscale serve --bg --https=<port>` as the share port is.
  `shareRefusal` and `isTendbMapping` (`sharing/serve-mapping.ts`) learn the second port: the same Funnel and TCP
  refusals, and 10db removes only its own mapping. Remote Access gains one step, "Pages shared", and a port field.
- Hosts: `<fqdn>:<preview port>` only, else 421. Origins: its own, or none. A request whose
  `Tailscale-User-Login` isn't the host's own gets 403, as on the share listener.

### 2.2 Sessions

1. A full-authority client calls `POST /projects/:projectId/preview/session { route, taskId?, picker }` on the API
   and gets `{ url }`: `https://<fqdn>:<preview port>/__10db/open?ticket=<ticket>`. The ticket is 24 random bytes,
   lasts 30 s, is used once and is held in memory (the stream ticket's rules, remote-host §5.3). `route` is a
   path: it starts with one `/`, never `//` or a backslash. `picker` is `shell` (the Preview window adds its own),
   `web`, or `none`; `web` needs a `taskId`, the page that gets its picks.
2. **The open exchange, two answers.** `GET /__10db/open` checks the ticket and answers a small page with
   `Clear-Site-Data: "cookies", "storage"`; the page posts the ticket to `/__10db/enter`, which spends it, sets
   `__Host-tendb-preview` (`HttpOnly; Secure; SameSite=Lax; Path=/`) and the dev login's cookies as host-only
   cookies, and redirects to the route. Two answers, because a cookie set beside `Clear-Site-Data` may be cleared
   with the rest. Site data is cleared only when the open request's old cookie names another project's session
   or no known one, since every project shares this origin; reopening the same project keeps the dev app's
   storage and the first answer carries no `Clear-Site-Data`.
3. A session is held in memory: its project, its page (`taskId`, fixed at open, never taken from a request), the
   principal that asked (a device, or the host's window), and a 12-hour idle expiry. A browser holds one: a new
   open ends the cookie's last session.
4. Each proxied request, and each minute an upgraded socket stays open, renews a preview hold
   (`preview/` `hold`, 5 minutes past the last ask), so an idle session doesn't keep a dev server up.

| Session state                      | Event                                            | Then                                                                  |
| ---------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| Ticket made                        | entered within 30 s                              | Live; the cookies are set                                             |
| Ticket made                        | 30 s pass, or entered twice                      | 401; the client asks for a new one                                    |
| Live                               | request with the cookie                          | proxied (§3); the hold is renewed                                     |
| Live                               | the same browser opens another session           | ended; its proxied sockets close; the new one is Live                 |
| Live                               | its device is revoked                            | ended; its proxied sockets close, the HMR socket included             |
| Live (the host's own window asked) | a device is revoked                              | unchanged                                                             |
| Live                               | sharing stops, 12 h idle, or the daemon restarts | ended; the next request gets a page, "Open this page from 10db again" |
| Live                               | nothing answers at the app address               | a 502 page: "Starting the preview…", reloading until it does          |

### 2.3 The desktop and the shell

- `open_preview` and `open_app_page` (`src-tauri/src/preview.rs`, `app_page.rs`) accept loopback, as today, or
  exactly the selected host's preview origin, read from the shell's own host list (the Studio goal's
  `host-connection`). Nothing else.
- With a remote host selected, Mark Up Page asks for a `shell` session and opens its URL in the Preview window.
  The shell skips the local sign-in file; the exchange set the cookies. The window's runtime capability names the
  preview origin, and the five commands, the crop and the draft work as today.
- Open in Browser asks for a `web` session. Copy Link reads "Copy Link (works for 30 seconds)".
- The Studio goal's "this page runs on the Studio" gate (`remote-window-gates`) is removed for these controls.

## 3. M1: the proxy and the browser picker

### 3.1 The reverse proxy (`apps/daemon/src/preview-proxy/`)

M1's alone; the guest door (§5.1) shares none of it. It takes a target (the project's loopback `appUrl`) and
streams HTTP and WebSocket upgrades.

- **Request:** `Host`, `Origin` and `Referer` are rewritten to the target's. 10db's session cookie and every
  `Tailscale-*`, `Cf-*` and `X-Forwarded-*` header are removed. `Accept-Encoding` is removed so HTML can be edited.
- **Response:** a `Location` on the target's origin is rewritten to the public one. `Set-Cookie` loses its
  `Domain`, and one named `__Host-tendb-*` is dropped. An HTML response of a `web` session gets
  `<script src="/__10db/picker.js">` as the first child of `<head>`, because React's devtools hook must install
  before React loads (`apps/desktop/src/picker/AGENTS.md`). When the page's own policy has a script nonce, the tag
  carries it.
- **Cookies ignore ports.** The preview cookie and the app's cookies are also sent to the share port and to the
  builder's own `serve` on 443 of the same name. They are the builder's own services; the share listener ignores
  cookies.
- **Path refusals,** a pure rule checked on the decoded path, answered 404 without forwarding: a `..` segment, a
  NUL or a backslash, and a segment that is `.git` or starts with `.env`. Everything else passes, Vite's
  `/node_modules/.vite`, `.pnpm` and `/@fs/` paths and source maps included: the caller is a paired,
  full-authority device and Vite's own `server.fs` rules still apply.

### 3.2 The browser picker

Shared by M1 and M2, and built by whichever ships first. A second build of `apps/desktop/src/picker` with a
same-origin `fetch` channel in place of `channel.ts`, built with the served app (the precedent is
`api/app-static.ts`) and served at `/__10db/picker.js` by the preview listener or the guest door. The server
prefixes it with a small config object, as the shell's `init_script` does: the mode (`device` or `guest`), the
Send label, the pick limit and the path to post to. The spike's fixes are part of this build, and the first three
reach the Preview window's too:

- Send waits for picks still in flight; a note left open when Send is pressed is saved first.
- The overlay's styles go in through `adoptedStyleSheets`, so a page's `style-src 'self'` leaves it styled.
- `engine` is read from the browser.
- The pill reads "Mark up", then **Send to 10db** (`device`) or **Send to <builder's name>** (`guest`). Picks stay
  on the page until Send. The shortcut is ⌥⇧M, since ⌘⇧C is Chrome's own.
- No dictation, no crop taken in the page. At most 8 picks per Send.

### 3.3 The pick route (M1)

`POST /__10db/picks` on the preview listener: a `web` session, the listener's own `Origin`, at most 64 KB, parsed
as `PagePickBatch` (§6), at most 2 a second and 30 a minute per session. The daemon checks each source path again
(`isProjectSource`) and publishes `page.picks { taskId, picks }` to `full`-scope sockets, with `taskId` from the
session. The UI adds the chips through the code `preview-pick` uses. The daemon stores nothing: with no `full`
socket open it answers 409 and the picker keeps its picks and says "Open 10db to receive these".

It must never do what Pick on Page §5 lists: send a message, answer a card, start anything.

## 4. M1: the matrix, failures and tests

**Auth matrix.** `auth-matrix.ts` gains a `Preview` column with the listener's own classes: `PreviewOpen` and
`PreviewEnter` (no credential; the handler checks the ticket), `PreviewPicker` and `PreviewProxy` (a preview
session), and `PreviewPicks` (a `web` session). The preview app reads this table; it has its own path-to-class
function, since `routeClassOf` defaults to `Api`. `PROTOCOL_VERSION` goes up once for M1 (`page.picks`, the
session route), so a laptop and a Studio on different builds say so rather than fail.

**Failures.**

- The preview port is held at start: the Pages shared step names the holder; sharing itself stays up.
- A page whose policy allows neither same-origin scripts nor a nonce gets no picker; the pill is absent.

**Tests** (`.claude/rules/testing.md`: permissions and a new network path are core).

- The matrix's table test gains the column. Its wiring test asks the preview listener for every API route class
  with every credential and sees the proxied app's answer or a 401, never an API handler's.
- The proxy's refusals and header rewrites: one pure rule test.
- Sessions: the ticket's single use and 30 s (clock injected), and a revoked device's proxied WebSocket closing,
  on a real socket, extending the revoke test.
- `serve-mapping`'s pure table gains the second port. Rust: `app_page.rs`'s table gains the host-origin rows.
- e2e: `workbench.spec.ts` opens a `web` session, loads the proxied page, sends one pick and sees its chip. The
  preview listener needs sharing on, the tailnet `Host` and HTTPS, so the e2e's stand-ins
  (`e2e/tls-standin.ts`, `fake-tailscale.mjs`) gain the preview port. No component test.
- By hand, on a real Vite app and a real Next app through `serve`: the page loads and HMR holds (§11).

## 5. M2: guest links

```
Mark's browser ── Cloudflare ── cloudflared ── guest door ── guest server (the built app)
                                               │   ▲
                                        outbox │   │ table file
                                               ▼   │
                                              daemon ── Inbox card, crops
```

### 5.1 The guest door (`apps/daemon/src/guest-door/`)

A second Node entry point, bundled beside the daemon (`srt.mjs` is the precedent): about 400 lines, `node:http`
and zod, no workspace import but contract types.

- **How it runs.** The daemon starts it while a link is live, on `127.0.0.1:<guest port>` (default 4321), through
  the gate runner with `rules: []` and loopback on. Its process goes in a ledger; an exit is restarted with
  backoff.
- **Its folder is `~/.10db/guest-door/`:** `table.json`, `picker.js` and `outbox/`. It is outside the data
  directory, which a gate run can't read, and it is a protected read for every other run (lanes, gates, guest
  builds, MCP servers), because the table holds sign-in cookies and the nonce.
- **What the door may read is the containment,** since its answers are a way out: its own bundle and Node, and
  its folder, with `table.json` and `picker.js` read-only and `outbox/` write-only. Nothing else: not the data
  directory, the database, the Keychain, a checkout or any `.env`. It reaches no host off the Mac.
- **M2's first card** settles three things: whether the gate runner takes a folder that isn't a project's
  (`GateRunInput.project.repoPath`), whether it can grant exactly those reads and writes, and that nothing here
  needs a signal (the gate's shell traps only TERM and INT). If the runner can't take it, the door runs as a
  plain child process: separate from the daemon, without the kernel's containment, and the docs say so.
- **It holds:** the table the daemon wrote (§5.2), nothing else. It never calls the daemon and has no credential
  to call it with. With loopback on it can knock on the daemon's main port, where it holds no token.
- **It answers only `r-<id>` hosts of links in its table.** Any other `Host`, an ended link's included, gets one
  page, "This link has ended", with the same status. It believes no forwarded header.
- **Before any cookie is checked:** at most 256 connections in all, and 10 s each for a request's headers and
  body, so slow strangers can't use up its file descriptors. A request whose `Origin` is present and isn't its
  own host is refused: links are same-site with each other, so `SameSite=Lax` cookies ride along from `r-a` to
  `r-b`, and the pipe's `Origin` rewrite would hide that from the app.
- **Its routes,** in order; everything else is the app:

| Request                                           | Needs                    | Does                                                                                                   |
| ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET /<secret>` (one segment, the secret's shape) | the link's secret        | sets `__Host-tendb-guest` to the secret (`HttpOnly; Secure; SameSite=Lax`) and the guest sign-in's cookies; `303` to the link's route |
| `GET /__10db/hello?n=<nonce>`                     | the table's nonce        | echoes it (§5.5); any other nonce gets the ended page                                                  |
| `GET /__10db/picker.js`                           | the cookie               | the guest picker (§3.2)                                                                                |
| `POST /__10db/notes`                              | the cookie, its own `Origin` | caps the body at 64 KB, checks it is JSON, writes `outbox/<link>/<id>.json` (a temp file, then a rename), answers `{ received }` |
| a loopback `Host`, `GET /__10db/version`          | nothing                  | the version of the table it last read, for the daemon (§5.2)                                           |
| anything else                                     | the cookie               | piped to the link's server, WebSocket upgrades included (at most 4 per link, 64 connections)           |

- **The cookie is the link's secret.** The door hashes it and looks the link up by `Host`, in constant time. There
  is no session to store, so Mark's tab survives a restart of the door or of 10db. A wrong or missing cookie gets
  the ended page; nothing counts tries, so a stranger can't lock Mark out. The secret is 256 random bits.
- **The pipe.** `Host`, `Origin` and `Referer` are rewritten to the server's; the door's cookie and every `Cf-*`
  and `X-Forwarded-*` header are removed, and `Accept-Encoding` too, so HTML can be edited. On the way back `Set-Cookie` loses its `Domain`, an HTML answer gets
  `<script src="/__10db/picker.js">` first in `<head>` (with the page's nonce when it has one), and every answer
  gets `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` and the policy below. Three refusals stay as
  cheap cover for a sloppy start command: a `..` segment, a segment starting with `.` (but `/.well-known/`), and
  `*.map`. There are no dev-server rules, because no dev server is behind the door.
- **The policy,** on every piped answer: `default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:;
  connect-src 'self'; frame-ancestors 'none'; form-action 'self'`, plus the project's `guestBrowserHosts`. A
  second policy only tightens the app's own. It limits where Mark's browser connects, not what inline code runs.
- **While the server isn't answering,** the door shows "Starting the preview…" (reloading) or "Not available
  right now", as the table says, each with "Notes you already sent have arrived" where true.
- **Send limits:** 8 picks and 64 KB a Send; 10 Sends an hour and 50 in all per link, counted by the door and
  again by the daemon when it reads. Past them the door answers 429: "That's the most this link takes."

### 5.2 Links (`apps/daemon/src/guests/`)

- **A link** has an id (`GuestLinkId`, a branded `gl_` plus UUIDv7), a host label (`r-` and 10 random lowercase
  base32 characters, not secret: it shows in DNS) and a secret (`tdg_` and 32 random bytes, base64url). The URL is
  `https://r-<label>.<domain>/<secret>`, returned once by the create route and shown in the dialog at Ready.
  `guest.domain` is an `app_settings` key (`10db.app`), and the full hostname is stored on the link.
- **Routes,** on the API (L7): `POST /projects/:projectId/guest-links { commit, route, label, expiresInDays }`,
  `GET /guest-links`, and `POST /guest-links/:id/` `extend`, `rebuild`, `revoke` and `token` (a fresh secret,
  returned once; the old one ends). All are in the matrix's `Api` class: the UI token on Main, a device token on
  Share; each handler refuses a dev-UI or render token with 403. Events: `guest_link.changed`. `route` is a path:
  one leading `/`, never `//` or a backslash.
- **The table file** is how the daemon tells the door anything: `{ version, helloNonce, links: [{ host,
  secretHash, state, expiresAt, upstreamPort, route, browserHosts, signInCookies, sendsLeft }] }`, written 0600
  as a temp file then a rename, holding live links only. The door parses it with zod and keeps the last good one.
  The nonce is made once per door start, so the table changes only when a link does.
- **A change reaches the door by the file alone.** The door checks the table's mtime every second and re-reads
  it when it moves. The daemon writes the table and reads `/__10db/version` on loopback until the door reports
  the new version (at most 5 s; past that the door is restarted, which also applies it). Only then does Revoke
  answer. The door closes every socket of a link that left the table, and drops a link itself once `expiresAt`
  passes.

| State                  | Event                                                 | Then                                                                                                          | Mark sees                  |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Building               | the build, the first start and the front door pass    | Ready; the dialog shows the link                                                                              | "Starting the preview…"    |
| Building               | the build, start or bind check fails; 20 minutes pass | Failed, with the output's tail. 24 hours later, with no Rebuild, it is Revoked                                | "Not available right now"  |
| Building               | the daemon restarts                                   | Building again, from the build                                                                                | "Starting the preview…"    |
| Failed, Ready, Broken  | Rebuild                                               | the server stops; Building                                                                                    | "Starting the preview…"    |
| Ready                  | the server exits, or the bind check fails             | restarted, at most 3 times in 10 minutes (`restart-budget.ts`), then Broken                                   | "Starting…", then "Not available right now" |
| Ready                  | the daemon restarts                                   | the ledger ends the old door and server; both start again; Ready. The cookie still works                      | Cloudflare's error, then the preview |
| Failed, Broken         | the daemon restarts                                   | unchanged; nothing is started until Rebuild                                                                   | "Not available right now"  |
| Ready                  | the server starts, and every 24 hours after           | `guestLoginCommand` runs again and the table gets the new cookies; a guest whose sign-in lapsed reopens the link | no change                |
| any but Revoked        | `expires_at` passes, Revoke, or the project is removed | Expired or Revoked: out of the table, sockets closed, build or server killed, teardown run, worktree removed | "This link has ended"      |
| Expired                | Extend, within 7 days                                 | Building, same secret and host                                                                                | "Starting the preview…"    |
| any live               | New Link                                              | a new secret in the table; the old cookie and URL end                                                         | "This link has ended"      |
| any live               | a guest command changes                               | unchanged: a link runs the commands it was built with; its row says so, with Rebuild                          | no change                  |
| any live               | `guestDocker` or Allow loopback changes               | read at the next start; with loopback off the start fails: Broken                                             | no change, or "Not available" |

Live means Building, Failed, Ready or Broken: its secret is in the table and it counts toward the 3 on a Mac. A
Ready link's server stays up until the link ends.

### 5.3 The outbox, the card's notes and the crops

- **The door writes; the daemon reads.** The daemon watches the outbox (and polls it every 5 s). For each file
  it parses `GuestFeedback` (§6) with zod, checks the link is under its limits, writes one `guest_feedback` row
  keyed by the file's id and opens or extends the link's card in one transaction, then deletes the file. A file
  whose id already has a row is deleted unread, so a crash between the two is safe. A file that fails the parse
  is deleted and counted, never logged.
- **The reader trusts nothing the door wrote,** names included, because the door is the process assumed
  breakable:
  - It never follows a symlink, for `outbox/`, a link's folder or a file (`lstat`, `O_NOFOLLOW`), and takes
    regular files only.
  - A folder's name must be a live link's host label and a file's name must match the id's fixed pattern; the
    link and the id come from those names, never from the body.
  - A file over 64 KB is refused before it is read. At most 50 files are taken per pass.
  - It deletes only by a path it built itself from those checked names, inside `outbox/`. Anything else in the
    folder is left alone and counted.
- **Mark sends text only.** The picker in `guest` mode posts `{ v, picks, sentAt, userAgent }`: no image, no
  `component`, no `source`. The daemon decodes nothing a guest made but that JSON.
- **The Studio takes the crops** (the builder's choice), after the card is made. For each pick the pictures
  camera loads the pick's `route` (checked as a same-origin path) on the link's guest server, signed in with the
  link's cookies, at the pick's viewport clamped to 4000 px a side and a pixel ratio of 3, finds the element by
  its selector, scrolls to it and clips its box padded as Pick on Page §6. An area pick clips its box. An
  element that isn't found, or a link that has ended, leaves the note with its text and no crop. The card updates
  as crops arrive.
- An in-page crop can be added later as one optional field on a pick, with no change to the door's shape.

### 5.4 The guest build and server (`apps/daemon/src/guest-preview/`)

Project settings, beside `previewCommand` in `packages/contracts/src/entities.ts`:

| Field                             | Runs                                                                           | Sandbox                                                  |
| --------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `guestBuildCommand`               | once per build, in the link's worktree                                         | the gate's, with the project's hosts (a build may fetch) |
| `guestStartCommand`               | while the link is live; serves at `TENDB_APP_URL`, a loopback port 10db picks  | the gate's, with **no hosts** and loopback on            |
| `guestTeardownCommand` (optional) | when the link ends; drops what the run made                                    | as the start command                                     |
| `guestLoginCommand` (optional)    | after the server answers; prints a URL or path that signs a browser in         | as the start command                                     |
| `guestDocker` (a switch)          | (no command)                                                                   | off by default; on, all four commands may use Docker     |
| `guestBrowserHosts` (a list)      | (no command)                                                                   | hosts Mark's browser may call (§5.1); empty by default   |

- **Where:** a worktree at the link's commit under `~/.10db/worktrees/`, with its own `node_modules` from the copy
  template (`decisions/2026-11-17-a-copys-node-modules-is-cloned-from-a-template-made-once-per-lockfile.md`).
  Each link has its own server. Each command gets `TENDB_GUEST_ID`, which joins the sandbox's env allowlist
  (`sandbox/env-allowlist.ts`) beside `TENDB_COPY_ID`.
- **How:** the unslotted gate runner, as the preview uses, with `rules: []` for the start, teardown and login
  commands (`GateRunInput.rules` is already per run). Docker follows `guestDocker` alone, never the project's own
  switch. The process tree goes in a ledger (`preview/preview-ledger.ts`'s pattern).
- **Refused before a worktree is made:** a project without Allow loopback or without the build and start
  commands, and a disk under its floor. Share for Review says which.
- **The bind check:** once the server answers, and every 30 seconds after, 10db reads the listening sockets and
  addresses of the server's process tree. One bound beyond loopback ends the run: "The guest server listened
  beyond this Mac." This is a new `lsof` parser; `sharing/lsof-holder.ts` reads one port's holder only. It covers
  processes 10db started, not a container's published port.
- **Sign-in and data are the builder's.** `guestLoginCommand` signs the guest in as whoever it names; the
  fictional-user check (`pictures/fictional-account.ts`) is the dev login's and doesn't apply. The cookies go in
  the door's table, which is removed with the link.
- **Build-time values:** a guest build can't read `.env*`. The project gives its values inline in the command,
  from a committed file, or from a `.env.guest.example` template, which the gate can read.

**What the sandbox confines, and what the settings page says.** Nothing in the right column is forbidden to the
builder. Guest Preview settings state it above the commands, in these words or close to them, and Share for
Review repeats the lines that apply:

> Anyone with the link sees and can change whatever this build serves, signed in as whoever the sign-in command
> names. Use data you're happy to show.
>
> The guest server runs sandboxed: it can't reach the internet or read `.env` files. It can reach every server on
> this Mac's localhost, your dev database included, so point it at its own.
>
> (Docker on:) The guest server's network is no longer confined to this Mac. Containers can reach any host.

| Confined by default (the kernel sandbox, or the guest door)                     | Not confined, and said in Settings                                         |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| The guest server reaches no host off the Mac.                                   | With `guestDocker` on: nothing about egress is confined.                   |
| The build and server read no `.env*` file and inherit no secret-named variable. | A key committed in the repository or typed into a guest command.           |
| The guest never is the live dev server: another folder, port and process.       | **Loopback is all or nothing:** every local server is reachable.           |
| A server 10db started that binds beyond loopback is stopped within 30 s.        | The seconds before the check; a container's published port.                |
| Every answer carries a policy limiting where Mark's browser connects (§5.1).    | Navigation: a page can still send the browser to another site.             |
| (nothing)                                                                       | What the data is, and who the guest is signed in as: the builder's choice. |

### 5.5 The tunnel and the hostnames (`apps/daemon/src/tunnel/`)

- **Setup, by the builder, once:** in Cloudflare's dashboard, create a tunnel, add the public hostname
  `*.10db.app` pointing at `http://127.0.0.1:4321`, add a proxied wildcard DNS record for it if the dashboard
  didn't (§11), and copy the tunnel's token. Settings › Remote Access › **Review links** shows these steps and a
  field for the token.
- **What the wildcard means.** Universal SSL covers first-level names, so `r-<id>.10db.app` has a certificate at
  no cost. An explicit DNS record keeps precedence over the wildcard, so the site and any other `10db.app` host
  are untouched. Every name with no record of its own reaches the door, which answers only live links' hosts.
- **What one hostname per link buys:** each link is its own origin, so the browser keeps two projects' cookies,
  storage and service workers apart, and nothing is cleared on the way in.
- **What links under one site still share:** `r-a.10db.app` and `r-b.10db.app` are same-site with each other and
  with every `10db.app` host. A preview's script can set or read a `Domain=10db.app` cookie, and same-site
  requests carry `SameSite` cookies to other `10db.app` hosts. The door drops `Domain` from the app's
  `Set-Cookie`; script can still set one. So the rule stands: **previews move to their own registrable domain
  before M3 or before anything on `10db.app` has a sign-in.** The domain is a setting, and each link stores its
  hostname.
- **The token** goes in the login Keychain (`environment/keychain.ts`) and reaches the child as `TUNNEL_TOKEN` in
  its environment, never in `argv` or a file. It can only run that tunnel. `~/.cloudflared` becomes a protected
  read (`sandbox/protected-reads.ts`), as Tailscale's credential is.
- **The binary** is a `PinnedRelease` (`environment/agent-pins.ts`), fetched and checked like the pictures
  browser, run with `--no-autoupdate`, and bumped in its own pull request at least once a year. The pin's `sha512`
  is computed from the download when the pin is made.
- **Running:** `cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:<port> run`, as the daemon's own child,
  outside any sandbox, in a ledger, while a link is live. No launchd service. An exit is restarted with backoff.
- **Health:** `GET /ready` on the metrics port every 30 s, then the front-door check: the daemon puts a nonce in
  the door's table and fetches `https://<a live link's host>/__10db/hello?n=<nonce>`; the answer must echo it.
  10db can't read the dashboard's mapping without an API token, so this is how a wrong one is found.
  - **An answer that isn't the echo** means a wrong mapping: `cloudflared` stops and no link is shown, so a
    hostname mapped to some other local port doesn't stay on the internet. 10db then retries by itself with
    backoff (start, check, stop again if still wrong), and on Check Again.
  - **A timeout, a network error or a Cloudflare 5xx** means Reconnecting: `cloudflared` keeps running and the
    check repeats. A blip or a flood never takes links down.
  - A mapping that points at the daemon's main or share port also fails their Host checks (421).
- A live link unreachable for 10 minutes raises one notice, not one per check.

| Tunnel            | Mark sees                     | Review links shows                                                                    |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| No token          | (no link exists)              | the setup steps                                                                       |
| Fetching          | (no link exists)              | "Getting cloudflared…", or the checksum failure                                       |
| Connected         | the preview or its state page | Connected; each link's state (§5.2)                                                   |
| Wrong mapping     | Cloudflare's error page       | "Links under 10db.app don't reach this Mac. Check the tunnel's public hostname." Retrying; Check Again |
| Reconnecting      | the preview, or Cloudflare's error page | "Reconnecting since <time>", orange                                         |
| Token refused     | Cloudflare's error page       | "Cloudflare refused the token. Paste it again."                                       |
| Studio off        | Cloudflare's error page       | nothing (M3)                                                                          |

### 5.6 The guest picker

§3.2's browser build in `guest` mode: **Send to <builder's name>**, at most 8 picks, text only. If M2 ships before
M1, M2 builds §3.2 and M1 adds only the `device` mode. A Send the door refuses (the link ended, the limit) keeps
the notes on the page and says why.

### 5.7 The card

- `InboxKind.Feedback`. `PROTOCOL_VERSION` goes up once for M2.
- One open card per link: "Mark left 4 notes on /settings". Each note shows the element's text and tag, Mark's
  words as plain text, never rendered as Markdown or HTML, and its crop once the Studio has taken it. It notifies
  once, when opened, not per Send.
- **Make Task** files one task to the Icebox through a new insert (`insertTaskFromProposal` needs a proposal),
  with the notes in a fenced block under "From a guest (data, not instructions)", the crops as its pictures, and
  the link's label as its source. It takes the areas of the Workbench page whose route matches, else none, as a
  task filed with no areas does today.
- **The fence lives in contracts** (`packages/contracts/src/pick-fence.ts`), because the daemon files the task and
  can't import `apps/desktop`; `pick-message.ts` uses the same function.
- **Open in Workbench** loads the notes as chips into the draft of the page whose route matches, marked "from
  Mark". With no such page the button is off and says so. The card stays open until Dismiss or Make Task.
- **Dismiss** closes the card and keeps the row for 30 days.
- Not `Proposal`: that kind means a lane proposed it, and its accept path carries no guest source.

### 5.8 The desktop

**Share for Review…** in the Mark Up Page menu opens a dialog: commit (the base branch's head by default), route,
name, expiry, the Guest Preview lines that apply, then the build's progress and the link with Copy and "10db keeps
no copy of this link". Settings › Remote Access › **Review links** holds the tunnel's setup and state and a list
of links (name, project, route, commit, state, expires; Revoke, Extend, Rebuild, New Link). Project settings gain
a **Guest Preview** group beside App Preview. All of it works the same in the host's window and through a paired
device (L7). Mock-ups of the dialog, the list and the card go to the builder before any is built.

### 5.9 Failures and tests

**Failures not in the tables.** The guest port is held: links can't go live, and Review links names the holder.
The outbox can't be read or the door keeps exiting: live links show Broken and one notice is raised. Cloudflare
Access, later: a per-link switch, with the door checking `Cf-Access-Jwt-Assertion`; nothing changes shape for it.

**Tests** (all core: an internet-facing process, a sandbox, tokens, untrusted input, a migration).

- **The door, alone, on real sockets against a stand-in app:** no cookie and a wrong secret get the one ended
  page and never reach the app; a flood of wrong secrets and of slow connections leaves a right one opening; an
  unknown `Host` and another link's `Origin` are refused; a Send over 64 KB or past the limit writes no file;
  the nonce echo. One test file.
- **Revoke:** the daemon rewrites the table, and an open proxied WebSocket closes before Revoke answers. One
  test, real door, real socket.
- **Containment,** if the gate runner takes the door: under the sandbox it can't read the data directory or a
  checkout, or connect off the Mac, and a gate run can't read the door's folder. Extends the sandbox's
  confinement and protected-reads tests.
- **The outbox reader:** a file is parsed, carded and deleted once; a replayed id makes no second note; a file
  that fails the parse makes no card; a symlinked folder or file, a FIFO, an oversize file and a wrong name are
  never read, and nothing outside `outbox/` is deleted. On a real SQLite file in a temp directory.
- On the API, in the matrix's wiring test: a device token and the UI token create a link; a dev-UI, render or
  MCP session token doesn't. The matrix gains no listener and no column.
- Guest build confinement, on the real sandbox with `guestDocker` off: a start command that connects off the Mac
  is refused, one that reads `.env` fails, and one that binds `0.0.0.0` is stopped by the bind check. The
  project's own Docker switch never turns Docker on. The protected-reads table test gains `~/.cloudflared`.
- Contracts, one pure test file: the fence can't be closed by a note's backticks, and `GuestFeedback`'s parse
  drops `component`, `source` and oversize text.
- The tunnel: the health, front-door and restart rules as a pure table, the child mocked: a wrong echo stops
  it and retries with backoff; a timeout, network error or 5xx keeps it running.
- The migration, through the existing migration tests.
- e2e: `workbench.spec.ts` makes a link with a stand-in guest command, opens it on the door through the e2e's
  TLS stand-in with `guest.domain` set to its name, sends one note, and sees the card, Make Task's fenced
  description and the chip from Open in Workbench. Ready needs the front door, and CI has no tunnel: the link
  service takes the front-door check as a dependency whose production default is the tunnel's, the e2e daemon
  is given a stand-in `cloudflared` by path (`TENDB_CLOUDFLARED`, as `TENDB_TAILSCALE_CLI` names the fake
  Tailscale), and the check's fetch goes to the TLS stand-in. No test-only branch. The real tunnel is checked by
  hand, once.

## 6. Data and contracts

```
guest_links     id (gl_…), owner_account_id, project_id, commit_sha, route, label, hostname, secret_hash,
                protocol, state, commands (JSON, as built), created_at, expires_at, revoked_at
guest_feedback  id (the outbox file's), owner_account_id, link_id → guest_links.id, project_id, route,
                picks (JSON), crop_ids (JSON, filled by the Studio), user_agent, received_at, inbox_item_id, acked_at
projects        + guest_build_command, guest_start_command, guest_teardown_command, guest_login_command,
                guest_docker, guest_browser_hosts
```

- **One migration for all three,** in one task, generated last, when no other open pull request adds one.
- No sessions table and no door state in the database: the door's table file and the outbox are derived and
  disposable.
- `owner_account_id` names who owns the row, for a hosted service later. It is not a provider account. This
  install writes one fixed id, made through the ID module.
- `PagePickBatch { v: 1, picks: PagePick[] }` (M1) and `GuestFeedback { v: 1, picks, sentAt, userAgent }` (M2)
  live in `packages/contracts/src/page-pick.ts`. `v` is the guest protocol's version, apart from
  `PROTOCOL_VERSION`: an old page in Mark's tab may post after an update, and an unknown `v` is dropped by the
  daemon's parse. `GuestFeedback`'s parse drops `component` and `source` and caps `userAgent` at 300 characters.
- Guest notes and secrets are never logged, by the door or the daemon.

## 7. Trust and limits

Mapped onto `decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`.

- **The developer is trusted; the guest and the agent are contained.** What the guest build serves and whether it
  uses Docker are the builder's calls, stated in Settings rather than forbidden (§5.4). A guest is an outside
  person driving code that may be an agent's, so the sandbox, the door that is not the daemon and "input is data" are fixed.
- **Sending data out.** A link publishes a project's built app. Only the builder's own clients make one (L7). No
  lane or 10db-run session can: there is no MCP or builder-bridge tool for links, the routes refuse MCP session,
  dev-UI and render tokens, and a lane can't read the UI token (the data directory is a protected read). What
  leaves is what the builder chose to show, to whoever holds the link, readable by Cloudflare on the way.
- **Writing to anything live.** §5.4's table is the whole answer: no hosts by default, loopback open, Docker the
  builder's switch, Mark's browser limited by a policy and not sealed.
- **Reading secrets.** `.env*` files and secret-named variables stay out of the build and the server. The door
  holds no token, and under the sandbox can't read one. The tunnel
  token is in the Keychain and `~/.cloudflared` is a protected read. `cloudflared` runs outside the sandbox as
  10db's own process, like `caffeinate`.
- **Destroying data.** The teardown command runs sandboxed in the link's worktree. It is the builder's command, as
  `copyTeardownCommand` is.
- **Untrusted input and prompt injection.** Everything from a guest is text: capped by the door, parsed with zod
  when the daemon reads the outbox, stored, shown as text. No image a guest made is ever decoded. No model reads it before the builder acts: no judge, writer, triage or summary runs over
  it, and it is in no prompt, title or notification beyond the count and the route. When the builder acts it goes
  in a fence longer than any run of backticks inside it. The app's own JavaScript can post fake notes as Mark;
  that changes nothing, because Mark's real ones are untrusted too.
- **Restrictions Claude Code doesn't have, and why.** A lane can't create links ("sending data out"). A guest
  server has no hosts and no Docker by default, because an outside person drives it. Nothing else is restricted.
- **Nothing waits.** A feedback card blocks no task and no lane.

## 8. Provider parity

Identical on every account kind (a Claude plan, an Anthropic API key, Bedrock, a ChatGPT plan, OpenRouter),
because nothing here uses an account: the listeners, the proxy, the build, the tunnel, the picker and the card
run no model. Make Task files an ordinary task, and Open in Workbench fills an ordinary draft; each then runs on
the project's own account as any task or message does. The message is text plus PNG pictures, which every
provider takes today (Pick on Page §4). Nothing is lacking on any provider, so no follow-up is owed.

## 9. M3 and keeping a hosted service additive

**M3 (cut):** a Cloudflare Worker with one Durable Object per builder in front of the same door and outbox. It is
the base for a possible paid hosted service. With the Studio down Mark has no preview, so its value before then
is small.

**The seams M2 leaves.**

- The door speaks plain HTTP on loopback and believes no header, so a relay stands where the tunnel does.
- The daemon already pulls notes from an outbox and parses them; a Durable Object is another outbox.
  `guest_feedback` has `received_at` and `acked_at` for it.
- The daemon hands the door hashes and a table; a relay is handed the same (L8).
- `owner_account_id` is on both tables from the first migration, and `GuestFeedback` is versioned.
- The domain is a setting and the hostname a column, with one host per link already.
- The door holds no builder credential, so a hosted front end never holds one.
- **Before M3, or before anything on `10db.app` has a sign-in:** previews move to their own registrable domain
  (§5.5).

## 10. Docs

Written with the milestone that makes them true:

- **M1:** `docs/architecture/03-trust-boundaries.md` §4 and `apps/daemon/AGENTS.md` (the preview listener and its
  session), `apps/desktop/AGENTS.md` and `apps/desktop/src/picker/AGENTS.md` (the browser build), module notes in
  `preview-listener/AGENTS.md` and `preview-proxy/AGENTS.md`, and a note on Pick on Page §5.
- **M2:** `03-trust-boundaries.md` §4, `docs/security.md` and `apps/daemon/AGENTS.md` stop saying the tailnet is
  the only reach and name the guest door and the tunnel; module notes in `guest-door/`, `guests/`,
  `guest-preview/` and `tunnel/`; a guide to writing a project's guest mode. The three decision records merge
  with this spec.

## 11. Unknowns

- **Whether the gate runner can sandbox a process whose folder isn't a project's,** and grant it only its own
  folder, read-only but for the outbox (M2's first card; §5.1).
- Whether a wildcard public hostname on a remotely managed tunnel makes its own DNS record or needs one made by
  hand, and whether `cloudflared` forwards the public `Host` unchanged (checked by hand at setup).
- Whether the pictures camera can scroll to a selector and clip today; §5.3 assumes a small change.
- Whether a sandboxed lane can read another process's environment, and so `TUNNEL_TOKEN`. `protected-reads.ts`
  relies on the sandbox's process-info limit; M2's tunnel card confirms it covers this. A run-only token would let
  a second connector receive a share of guest traffic, link secrets included.
- Whether HMR's WebSocket holds through `tailscale serve` and the proxy (M1's first card checks it by hand).
- Whether Safari honours `Clear-Site-Data` at all, and whether a cookie set beside it survives; M1's exchange
  assumes not. If Safari ignores it, the open page clears storage in script instead (M1's first card).
- The right checksum for the `cloudflared` release: its notes and GitHub's digest disagreed for 2026.11.2.
- Whether `next build` in a worktree needs anything from the main checkout, and how long a guest build takes.
- What runs on `10db.app` today and whether any of it sets a `Domain=10db.app` cookie.
- A tunnel's bandwidth limit (none is published).
