# 10db shares this Mac on the builder's tailnet, so their phone answers the Inbox from anywhere

**Status:** 2026-11-25; designed, not built (task S is in review). **Sizes:** S Core, slice 1 Core (an index and
about 12 cards), slice 2 Feature (one page, written after slice 1 merges). It replaces the unmerged 2026-11-12
remote-host design and its P1–P3 plans, keeping their reasoning where it still holds on `main`.

## Brief

**What changes for you.** Your laptop stays home. Settings gets **Remote Access**, a short checklist that ends
in **Share**: Tailscale is installed and connected, this Mac isn't tagged, HTTPS is on, the certificate has
issued. Then 10db answers on `https://<this Mac>.<tailnet>.ts.net:4319`, reachable from your tailnet and nowhere
else. **Devices** lists what you've paired, each with Revoke. Slice 2 adds the phone: scan a QR code on the
laptop, install the web app from Chrome, allow notifications. After that your Android phone shows the Inbox, buzzes
when a card needs you, and answers it, from anywhere your phone has signal.

**How devices pair (your call, 2026-11-25): a QR code plus a one-time code.** A paired screen shows an 8-character
code, valid for 5 minutes, used once, and burned after 5 wrong tries, with a QR code that holds it. The phone scans
the QR code. The laptop, when a Studio is the host later, types the Studio's name and the code. **Nothing syncs:**
every device is a window onto one host's database and keeps only its own revocable token. **Revoke** on any paired
screen cuts a device off and closes its connections at once, so a lost phone is revoked from the laptop.

**What it buys.** Answering an attended chat's permission card, a plan or a check while you're away, with no lag
from copies to reconcile. All of it carries straight over to a Mac Studio: pair the laptop to it, and the phone
follows.

**What could go wrong, and how we'd know.**

- **Reaching the daemon from off the Mac is new attack surface.** Only your tailnet can reach it (`tailscale
serve`, never Funnel), and every remote request needs a device token. The auth matrix (§4.3) is one table test
  that walks every credential on both listeners; a missing cell fails it.
- **Your Mac's name is public.** When HTTPS is on, each certificate writes the name to the public Certificate
  Transparency logs. On this Mac HTTPS is already on, and a certificate issued during the 11-12 spike, so
  its current name is very likely public already. Renaming the Mac now only keeps later
  certificates clean. The Certificate step says this before the first issue.
- **Push may not arrive.** Chrome's push goes through Firebase Cloud Messaging, which needs Google Play services.
  The 10-minute phone check in slice 2 finds out.
- **A lane holding the share port after a crash.** A lane with localhost on could bind 4319 while 10db is down.
  10db unshares before it closes the listener, and at start a held port keeps sharing down and names the process.

**Calls you might disagree with** (each with its cost if wrong).

1. **Device tokens never expire;** Revoke is the off switch. Cost: a token copied off a phone works until you revoke
   it.
2. **Any paired device can pair another,** the phone included. Cost: whoever holds your phone can add a device. They
   could already approve your cards.
3. **The phone keeps its token in the web app's `localStorage`,** behind a strict CSP. Cost: an XSS in the served
   app would leak it; agent output never renders raw HTML.
4. **Slice 1 shows no Pair button.** The pairing page lives in the phone app (slice 2), so slice 1's Devices page
   lists and revokes only. Cost: slice 1 alone gives you nothing on the phone.
5. **The pages are "Remote Access" and "Devices",** under Connections, because "Sharing" already names a project's
   Slack page.
6. **Slack stays the stakeholder channel,** not a phone channel (refresh note §2).

**Needed from you:** a reply to this brief, then approval of the mock-ups (Remote Access, Devices with pairing, the
phone Inbox). In slice 2: 10 minutes with your phone.

---

The rest is for agents. Background, the rejected options and the facts behind §2 are in the refresh note
(`~/Agents/notes/10db/2026-11-25-remote-host-refresh.md`, outside the repo).

## Builder's cut

| #   | Milestone                                                                              | Size                       | Cut                                |
| --- | -------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------- |
| S   | Lanes, gates and MCP servers can't read Tailscale's local API credential               | Core (one fix)             | needed; in review                  |
| 1   | **Share this Mac:** the share listener, the auth matrix, devices, Remote Access        | Core                       | needed                             |
| 2   | **The phone Inbox:** the served app, pairing by QR, push                               | Feature                    | needed (goal G1)                   |
| 3   | The Board, the task view and chats on the phone; heartbeat, replay, optimistic answers | Feature                    | later                              |
| 4   | The Studio as host: the laptop's host switcher, Keychain tokens, the `*.ts.net` CSP    | Core (Keychain) + Feature  | later, once the Studio is bought   |
| 5   | The Workbench and Open Page over the tailnet, Copy SSH command                         | Core (exposes ports)       | later                              |

Only S, 1 and 2 run. Slice 1's plan is written from this spec; slice 2's one-page plan is written once slice 1
merges.

## 1. Decisions

| #   | Decision                                                                                                                                                                                                                       | Why                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **One host owns everything; clients are windows.** Its database, checkouts, worktrees and sessions stay on it. Nothing syncs between Macs; a device holds a token and what it has fetched.                                     | The simplest model with no lag from reconciling copies. Paths and checkout pins are local to a Mac anyway.                                                                                |
| R2  | **Sharing is `tailscale serve` to a second loopback listener,** `127.0.0.1:<share port>` (default 4319), started and stopped at runtime with no restart. The daemon never binds beyond loopback. Never Funnel.               | `serve` gives a real certificate, strips forged identity headers and proxies WebSockets (spike). A second listener changes nothing for running lanes, and avoids the dev daemon's 4317.  |
| R3  | **HTTPS only.** Until the certificate issues, remote clients can't connect and Remote Access says so.                                                                                                                          | Push and the service worker need a secure context.                                                                                                                                        |
| R4  | **A remote request needs a device token,** a ticket made from one, or one of the three open routes (§4.3).                                                                                                                     | `serve` and a local process both arrive from `127.0.0.1` and a local process can forge any header, so the listener and the token are what tell them apart.                                |
| R5  | **A device has full builder authority;** any full-authority client can make a pairing code.                                                                                                                                   | The daemon runs code with the builder's credentials, so a stolen device token is total anyway. Scopes would add friction and no safety.                                                  |
| R6  | **Pairing is a one-time code shown with its QR code** (builder's call). 8 Crockford base32 characters, 5 minutes, single use, burned by 5 wrong tries, held in memory. Making a new code cancels the open one.               | One step, no account, works for a phone (camera) and a laptop (typing), and over Screen Sharing to a headless Studio.                                                                    |
| R7  | **Tokens:** `tdb_<deviceId>_<secret>`, a 32-byte secret, stored only as SHA-256 and compared in constant time. No expiry; Revoke closes the device's sockets at once.                                                          | The norm for revocable personal tokens. An expiry means babysitting.                                                                                                                     |
| R8  | **The event stream opens with a ticket.** `POST /events/ticket` gives a 30-second, single-use ticket carrying its principal's scope (`full` or `dev_ui`; a render token stays off the stream, as today); `?token=` is removed.                                                                      | A token in a URL lands in logs. Every client then takes one path, the desktop and the dev UI included.                                                                                   |
| R9  | **Push carries only what a lock screen may show:** the card's kind and the task's headline. (Slice 2.)                                                                                                                         | Payloads are encrypted to the browser, but a lock screen is public.                                                                                                                      |
| R10 | **Lanes, gates and MCP servers can't reach Tailscale** (task S): `/Library/Tailscale` and `tailscaled.socket` are protected reads.                                                                                             | The standalone app's same-user proof is readable by any admin user; with localhost on, a lane holding it could drive `serve` or Funnel.                                                 |
| R11 | **No stored state names a machine.** The tailnet name is read from Tailscale at start and when it changes, never stored.                                                                                                       | A new host starts clean; sharing carries no stale identity.                                                                                                                               |

## 2. Shape on main

- **Daemon** (`apps/daemon`): a `sharing/` module (the Tailscale reader, serve control, the share listener and its
  monitor), a `devices/` module (pairing, tokens, tickets, the socket registry, revoke), and the principal in the
  API's auth middleware (`api/app.ts`, today an `if` chain that sets nothing).
- **Contracts:** `sharing.ts`, `devices.ts`, the ticket route's schemas, the two `/health` shapes, and events
  `sharing.changed` and `device.changed`. `PROTOCOL_VERSION` goes up once for the slice.
- **DB:** `devices` and `push_subscriptions` in one forward-only migration (`v0.1.0` is published).
  `push_subscriptions` is created now and written from slice 2, because only one open PR may add migrations.
- **Desktop:** Settings › Connections › **Remote Access** and **Devices** (app-wide sections in
  `views/settings/sections.ts`), the stream connecting by ticket, the health poll sending its credential.

## 3. Sharing this Mac

### 3.1 Remote Access

An app-wide section, on This Mac only. It reads each step live, re-reads every 10 s while open, and shows one
state: **Off**, **Setting up**, **Ready** or **Paused**.

- **Tailscale is named up front.** Under the heading, in every state: "Reach this Mac's 10db from your phone, and
  later another Mac. It runs over Tailscale ↗, a private network between your own devices, so nothing on the
  internet can reach it." The link goes to `https://tailscale.com`.
- **Before Tailscale is installed** the page shows one card in place of the checklist: "Remote Access needs
  Tailscale. Tailscale is a private network between your own devices. Your phone reaches this Mac through it, and
  nothing on the internet can. It's free for personal use." Three steps follow (install it on this Mac and sign
  in; install it on your phone and sign in to the same account; come back here, and 10db finds it on its own), with
  **Get Tailscale ↗** linking to `https://tailscale.com/download`. The page re-reads every 10 s, so the checklist
  appears once Tailscale is installed.
- The Pair dialog (slice 2) says the phone needs Tailscale on and signed in to the same account, with the same
  download link.

| Step        | Read from                                                                                                             | When it fails                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Installed   | the CLI at `/usr/local/bin/tailscale`, else `/Applications/Tailscale.app/Contents/MacOS/Tailscale`                    | the "needs Tailscale" card above                                                                                    |
| Connected   | `tailscale status --json`: `BackendState` is `Running`; the login from `User[Self.UserID].LoginName`, the name from `Self.DNSName` | "Open Tailscale and connect"                                                                          |
| Not tagged  | `Self.Tags` is empty                                                                                                  | "A tagged Mac gets no identity headers. Untag it in the Tailscale admin console."                                |
| HTTPS on    | `CertDomains` holds the name                                                                                          | "Turn on HTTPS" with the admin console's DNS link, and the name-is-public line below                            |
| Certificate | `tailscale cert --cert-file - --key-file - <fqdn>`: exit status and stderr only, output discarded (§3.4)              | "Getting a certificate… the first can take about ten minutes", the last error verbatim, and the DNS link        |
| Shared      | the share listener is up and `tailscale serve status --json` maps `<fqdn>:<port>` to `http://127.0.0.1:<port>`        | **Share**                                                                                                        |

- Every CLI output is parsed with zod; one it can't parse fails its step with "Tailscale answered in a way 10db
  doesn't read" and logs the output's shape, never its values.
- **The name is public.** The HTTPS and Certificate steps show the Mac's tailnet name and say: "Each certificate
  writes this name to public certificate logs. Rename this Mac first if the name says who you are." When a
  certificate already exists, the line says so instead.
- **Ready** once every step through Shared passes. The section's nav row and the sidebar footer then read "Shared
  on your tailnet".
- **Paused** when a step that passed fails later (Tailscale disconnected, the certificate expired, the mapping gone).
  The daemon re-reads Tailscale every 60 s while sharing is on, so it sees the break with the page shut. The footer
  reads "Sharing paused: <step>".
- **Stay reachable, Open at login and a Ready card** wait for slice 4; the laptop is home and is open.

### 3.2 Share and Stop

- **Share:**
  1. Start the share listener. If the port is taken, the step names the process (`lsof -nP -iTCP:<port>
-sTCP:LISTEN`) and offers a port field. Nothing is served until a listener is up.
  2. Read `serve status`. If the port already maps anywhere else, stop and say where it points.
  3. Run `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` through an injected runner with a 10 s
     timeout. A failure shows its stderr.
  4. Store `sharing.enabled` and `sharing.port` in `app_settings`.
- **Ports Share refuses:** 443, 8443 and 10000, Funnel's ports (443 also holds the builder's own serve config).
- **Funnel and TCP forwards:** the Shared step fails, and Share refuses, when `serve status` shows `AllowFunnel` or a
  `TCP` forward on `<fqdn>:<port>`. The monitor repeats the check every 60 s; a Funnel found there stops sharing.
- **10db removes only what it made** (`isTendbMapping`): a mapping that proxies `<fqdn>:<port>` to
  `http://127.0.0.1:<port>`, nothing else. Stop, shutdown and a failed restore remove only such a mapping.
- **Changing the port** while shared stops on the old port, then shares on the new one.
- **Stop** runs `tailscale serve --https=<port> off`, closes the share listener and every socket on it, and clears
  `sharing.enabled`.
- **Shutdown** removes 10db's mapping before the listener closes, so a process that binds the port later receives
  no device's traffic.
- **At start,** with `sharing.enabled`: start the share listener after the main one, read Tailscale, re-check
  `serve status`, restore the mapping. Start never throws for sharing: a slow or missing CLI is logged and the
  state is Paused. A port taken at start keeps the listener down, removes the mapping if it is 10db's, and names the
  holder. While the listener is down the monitor never re-shares.

### 3.3 The share listener

- A second `serve()` from `@hono/node-server` on `127.0.0.1:<share port>`, on the same Hono app, with its own
  WebSocket server. Every request on it is **remote**, whatever its headers say.
- A local process that connects to the share port directly is remote and needs a device token. It gains nothing.
- The listener tells the app which listener a request came on through the request's env binding, never a header.

### 3.4 The certificate

- **The first certificate is the builder's click** (their call, 2026-11-25). 10db can't tell whether a certificate exists without running `tailscale cert`, and the first issue publishes the name for good, so the Certificate step shows the name, the public-logs sentence and **Get Certificate**. 10db probes a name only after that click (it keeps a hash of the name, never the name).
- The probe runs at most once a minute and backs off to every 10 minutes on failure. Its result is cached; `PUT
/sharing` and the page's 10 s re-read read the cache and never run it.
- In the spike the first issue failed for about ten minutes (`SetDNS "_acme-challenge.<fqdn>" … failed to create DNS
  record`) and then issued: Let's Encrypt, 90 days, renewed by Tailscale. Whether each `tailscale cert` run makes an
  ACME attempt is unknown, which is why the probe is rationed.

## 4. Requests and auth

### 4.1 Host and Origin allowlists

| Listener | Hosts (else 421, before auth)                         | Origins (a request with another `Origin` gets 403 on every route)                                                                                   |
| -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main     | `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` | today's (`UI_ORIGINS` and the dev UI's), or none                                                                                                   |
| Share    | `<fqdn>:<share port>` only                            | `https://<fqdn>:<share port>` (the phone app), `tauri://localhost` and `http://tauri.localhost` (the laptop app, slice 4), or none (a non-browser client) |

- The Host check blocks DNS rebinding; today there is none. The Origin check extends today's stream-only check
  (`api/app.ts`, the `STREAM_PATH` middleware) to every route.
- The short tailnet name is left out: the certificate covers only the full name.
- The share listener's lists exist only while sharing is on with a known name; with none, it answers 503 to
  everything but `/health`.

### 4.2 Remote marking and the tailnet identity

A request is remote when it arrived on the share listener, or when it carries `Tailscale-Headers-Info`,
`X-Forwarded-For` or a tailnet `Host`. On the main listener the header signs only ever restrict a request.

A remote request whose `Tailscale-User-Login` differs from the host's own login gets 403, covering a tailnet shared
with other people. With no such header (a tagged peer) the device token alone decides.

### 4.3 The auth matrix

The middleware runs, in order: CORS with the listener's origins; the Host check; the Origin check; remote marking;
the credential, which sets a **principal** on the context (`thisMac`, `devUi`, `render`, `device` with its
`DeviceId`, or `none`); the skill-version check; `limitBody`; the routes.

| Credential                   | Main listener                                                                       | Share listener                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| None                         | `/health` (short shape); `/mcp`, whose handler checks the session token, as today   | `/health` (short), `POST /devices/pair`, `GET /app/*`; else 401   |
| UI token                     | everything, as today; a `full` ticket                                               | 401                                                               |
| Dev-UI token                 | its reads, as today; a `devUi` ticket                                               | 401                                                               |
| Render token                 | its reads, as today; no ticket (off the stream, as today)                           | 401                                                               |
| MCP session token            | `/mcp` only                                                                         | 401; `/mcp` and `/builder/mcp` are not routed here (404)          |
| Device token                 | 401                                                                                 | everything the UI token reaches but `/mcp`, `/builder/mcp` and `/screens/claim`; a `full` ticket |
| Ticket on `/events/stream`   | the socket, with the ticket's scope                                                 | the socket, device tickets only                                   |
| Revoked device, bad token    | 401                                                                                 | 401, the same body for an unknown id, a revoked device and a mismatch |

- **Device tokens work only on the share listener.** A device is by definition elsewhere; refusing it on the main
  listener keeps that listener's matrix as it is today.
- `/builder/mcp` stays UI-token only. `/screens/claim` stays local: only windows on the host draw screens for
  `see_screen`, so render tokens never cross the network.
- **`/app/*`** is a route class of its own: static files, no credential, share listener only, `GET` and `HEAD`
  only, never falling through to an API route. In slice 1 it answers 404; slice 2 fills it.
- The matrix is a pure table in contracts or `api/`, read by the middleware; one table test walks every row and
  cell, and one test runs it through the wiring with `app.request` on each listener.

### 4.4 `/health`

- With no credential, or a bearer that is none of 10db's (an MCP session token, a stale token), and with any non-device bearer on the share listener: `{ status, protocolVersion }`.
- With one: today's full shape (`startedAt`, `commit`, `devUiOrigin`). The desktop's 5 s poll sends its credential.

## 5. Devices

### 5.1 Pairing

1. A full-authority client calls `POST /devices/pairing-code`. The daemon makes a code (R6), keeps it in memory
   only, and answers `{ code, expiresAt, url }`, where `url` is `https://<fqdn>:<share port>/app/pair#code=<code>`.
   The code appears only in this response; no read route returns it, so a dev-UI or render token never sees it.
   With sharing not Ready it answers 409 and the client says "Finish Remote Access first".
2. The new device sends `POST /devices/pair { code, label, platform }`, on the share listener, with no credential.
   - At most 10 tries a minute across the listener; the 11th gets 429 before any code is looked at.
   - Every other refusal (wrong, expired, burned, spent) gets the same 401. A fifth wrong try burns the open code.
   - Success answers once with `{ deviceId, token, host: { name, fqdn, port, protocolVersion } }`, spends the code,
     and emits `device.changed { change: 'paired' }`.
3. The pairing dialog (slice 2) follows `device.changed`, shows "Paired: <label>" and closes.

### 5.2 Tokens

- `tdb_<deviceId>_<base64url secret>`; `DeviceId` is a branded `dev_` plus UUIDv7, made only through the ID module.
- **Check:** parse, load by id, refuse a revoked device, compare `sha256(secret)` with `crypto.timingSafeEqual`.
- `last_used_at` is written at most once a minute per device, with `device.changed { change: 'used' }`, so Devices
  follows it without polling.

### 5.3 Tickets

- `POST /events/ticket` with a credential answers `{ ticket, expiresAt }`: 24 random bytes, 30 s, single use, held
  in memory, bound to the principal and its scope (`full` or `dev_ui`; a render token gets none).
- The stream's handshake spends the ticket and registers the socket under its principal. The stream's own `full`
  check (who hears live frames) reads the ticket's scope instead of re-reading `?token=`.
- The desktop app and the dev UI (`apps/desktop/src/daemon/events.ts`) fetch a ticket before each socket open.

### 5.4 Revoking

Revoke, from any full-authority client, sets `revoked_at`, emits `device.changed { change: 'revoked' }`, closes the
device's sockets with code 4401 through the registry, and deletes its push subscriptions. Its next request gets 401;
the phone app (slice 2) then says "This device was removed from <host>. Pair it again to reconnect." and drops its
token.

### 5.5 Devices page

An app-wide section listing each device: label, platform, paired, last used, and **Revoke** with a confirm naming
the device. Revoked devices drop off the list. Slice 1 has no pairing button; the section's `planned` line says
"Pairing a phone arrives with the phone app." Slice 2 adds **Pair a device**: a dialog with the QR code, the code in
large type, a countdown and **New code**.

## 6. Data

```
devices            id (dev_…), label, platform, token_hash, created_at, last_used_at, revoked_at
push_subscriptions id, device_id → devices.id (on delete cascade), endpoint (unique), p256dh, auth,
                   created_at
```

- One migration, generated after the branch's final merge of `main`, and only when no other open PR adds one
  (`gh pr list`; the Focuses and Evals sessions add migrations too).
- `sharing.enabled` and `sharing.port` are `app_settings` keys. The tailnet name is never stored (R11).

## 7. States

| State       | Share listener | Mapping       | Remote Access shows                  | A remote request gets |
| ----------- | -------------- | ------------- | ------------------------------------ | --------------------- |
| Off         | closed         | none of 10db's | the checklist, Share                 | nothing (no listener) |
| Setting up  | closed         | none          | the failing step and its fix         | nothing               |
| Ready       | open           | 10db's        | Shared, the address, Stop            | the matrix            |
| Paused      | open or closed | maybe stale   | which step broke                     | 503 or nothing        |
| Port held   | closed         | removed       | the process holding the port, a port field | nothing        |
| Stopping    | closing        | removed first | Off                                  | sockets closed        |

## 8. Docs and the decision

- A new decision, "A shared Mac answers on its tailnet address", written with slice 1 and amending
  `2026-10-29-dev-ui-over-the-factory.md`: the dev UI's origin stays loopback, and the share listener adds the
  tailnet origin for device clients only. `tests/repo/src/dev-ui-origin.test.ts` keeps checking the dev UI and
  learns the share listener's list.
- `docs/architecture/03-trust-boundaries.md` §4.1 and §4.2, `docs/security.md` ("One macOS user"),
  `apps/daemon/AGENTS.md` and `apps/desktop/AGENTS.md` (their loopback lines) say a shared Mac answers its tailnet
  through `serve`, to device tokens only.
- Module notes in `sharing/AGENTS.md` and `devices/AGENTS.md`.

## 9. Slice 2 in outline (planned after slice 1 merges)

- A second Vite build of the desktop UI, served by the daemon at `/app/` on the share listener: a served connection
  (same origin, the device token in `localStorage`, tickets for the stream), the pairing page `/app/pair` reading
  the code from the URL fragment, a manifest with `display: standalone`, and a service worker.
- **The Inbox in the narrow band** (below 640 px, the shell's sheets): open rows from `GET /inbox/page`, the card,
  answer, take back. A short read-only Factory glance. Settings › This device: push on or off, Forget this device.
- **Push:** VAPID keys in the host's login Keychain; `push_subscriptions` written from the device; a server sender
  on the same "worth notifying" rule the desktop uses, moved from `desktop/notify-card.ts` and `notify-pass.ts`
  into contracts so the two can't drift. Asks notify; notices never do. Payload per R9.
- The Pair a device dialog (§5.5).
- Extend one e2e: pair at a phone viewport, see a card, answer it.
- By hand, 10 minutes: install from Chrome, allow notifications, see one buzz. If MagicDNS doesn't resolve, set
  Android's Private DNS to Off or Automatic.

## 10. Per provider

Sharing and devices don't touch an account. Every account kind (a Claude plan, an Anthropic API key, Bedrock, a
ChatGPT plan, OpenRouter) runs exactly as on This Mac, because a device only drives the host's daemon, which runs
the sessions with the host's credentials. Sign-ins that need the host's own browser (a Claude plan's, a ChatGPT
plan's on port 1455) stay on the host; slices 1 and 2 show no sign-in on a device, and slice 3 adds a "sign in on
the host" line per kind.

## 11. Testing

Within `.claude/rules/testing.md`: this is security and permissions, so the core rules get unit tests, each on the
cheapest real rung.

- **The auth matrix:** one table test over every row, and one wiring test through `app.request` on each listener,
  Host and Origin included.
- **Tokens and pairing:** the hash check and its one 401; the code's 5 minutes, single use, 5 tries and the 429
  coming before any lookup (clock injected).
- **Tickets:** single use, 30 s, scope carried (clock injected).
- **Revoke:** a real WebSocket on the share listener closes with 4401, and the next request gets 401.
- **Serve control:** `isTendbMapping` and the Funnel and TCP refusals as a pure table over parsed `serve status`,
  plus one test of Share, Stop and shutdown order with the CLI runner mocked (a child process 10db doesn't own).
- **The migration:** through the existing migration tests.
- **UI:** extend one e2e: Settings › Remote Access shows the Installed step's fix on a machine with no Tailscale,
  and Devices lists none.

## 12. Unknowns

- Whether `serve` forwards the original `Host` (`<fqdn>:<port>`) or rewrites it. Slice 1's first card checks it by
  hand against the real `serve`; the share listener's Host list follows what arrives.
- Whether the Vite dev server's proxy, the agent skill's CLI and the e2e harness all send a loopback `Host`. The
  Host-check card lists every caller.
- Whether srt can deny binding one loopback port while localhost is on; until then, unsharing first is the guard.
- Whether each `tailscale cert` run makes an ACME attempt.
- The Android checks (install, push, QR scan) are slice 2's 10 minutes by hand.
