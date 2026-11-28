# Guests reach a Studio over a Cloudflare tunnel, not Funnel, on a listener that routes no API

- **Date:** 2026-11-27
- **Amends:** `decisions/2026-11-25-a-shared-mac-answers-on-its-tailnet-address.md`

## Decision

Designed, not built. The design is `docs/superpowers/specs/2026-11-27-10db-review-links-design.md` (§1, §5.1,
§5.2, §5.5).

- A guest, someone the builder sends a review link to, reaches 10db through a Cloudflare named tunnel. 10db still
  never turns on Tailscale Funnel, and the builder's own access (the share listener and the preview listener)
  stays on the tailnet.
- The amended record says "the tailnet is the only reach". That still holds for the daemon. One process 10db
  starts, the **guest door**, is reachable from the internet through the tunnel.
- **The listener the tunnel points at is not the daemon's.** The guest door is its own small process, on
  `127.0.0.1`, that the daemon starts under the kernel sandbox while a link is live. It holds no token and no
  database and never calls the daemon. It checks a link's secret against hashes the daemon hands it in a file,
  serves the built guest preview with the picker added, and writes each Send to an outbox folder.
- **The daemon pulls.** It reads the outbox, parses each file with zod and makes the Inbox card. It handles no
  request from the internet, gains no listener, and the auth matrix gains no column. It trusts nothing the door
  wrote, file names included: it follows no symlink, takes only small regular files with names of a fixed
  pattern under a live link's folder, and deletes only by paths it built itself.
- **Revoke reaches the door through the file.** The daemon rewrites the table; the door re-reads it when its
  mtime moves; and Revoke answers only once the door reports the new table. The door closes the open sockets of
  a link that left it. No signal is used, because the gate's shell passes none on.
- **What the door may read is its containment,** since its answers are a way out: its own folder
  (`~/.10db/guest-door/`), with the table read-only and the outbox write-only, and nothing else. That folder is
  a protected read for every other sandboxed run.
- The door refuses a request whose `Origin` is another host, and caps connections before it checks a cookie.
- If the gate runner can't sandbox a process whose folder isn't a project's (unverified), the door runs as a
  plain child process: still separate from the daemon, without the kernel's containment.
- The door trusts nothing about how a request arrived: plain HTTP on loopback, no forwarded header believed. A
  relay can stand where `cloudflared` does, and can be another outbox, without a change to it.
- **One hostname per link,** `r-<id>.10db.app`, behind a wildcard hostname on the tunnel. The door answers only
  the hosts of live links. The secret stays in the path, because DNS and TLS show hostnames. Explicit DNS records
  keep precedence over the wildcard.
- The builder creates the tunnel once, by hand, in Cloudflare's dashboard and pastes its token. The token can
  only run that tunnel. 10db keeps it in the login Keychain and never holds a Cloudflare API token or `cert.pem`.
- 10db runs a pinned `cloudflared` (a `PinnedRelease`, with `--no-autoupdate`) as its own child while a link is
  live, with no launchd service. It reads health from `cloudflared`'s `/ready` and from a request of its own
  through a link's public hostname. When that request is answered by something other than the door, 10db stops
  `cloudflared` and shows no link, so a hostname mapped to some other local port doesn't stay on the internet,
  and retries by itself with backoff. A timeout or a Cloudflare error is not that: the tunnel keeps running.
- No Cloudflare Access in the first build. The link's secret is the only lock: 256 random bits, 7 days by
  default, revocable, stored only as a SHA-256 hash. Nothing counts wrong tries, so a stranger can't lock a
  guest out.
- Calls and their costs:
  - Cloudflare ends the TLS connection, so it can read a guest's traffic and the secret in the link.
  - Anyone holding a link sees the preview until it expires or is revoked.
  - 10db can't read or fix the dashboard's mapping; it can only find that a hostname doesn't reach the door.
  - Every unused name under `10db.app` reaches the door, and a link's id shows in DNS.
  - Links under `10db.app` are separate origins but one site: a preview's script can set or read a
    `Domain=10db.app` cookie. Previews move to their own registrable domain before a relay serves them or
    anything on `10db.app` has a sign-in.

## Why

- A partner has to open a link with no install and no account, so the tailnet can't carry it: sharing a node
  needs the guest to have a tailnet of their own.
- Funnel was turned down. It publishes the tailnet node that also carries the share listener, on a name that is
  the Mac's own, and Funnel requests carry no identity header, so a Funnel pointed at the wrong port would leave
  a device token as the only check. A tunnel on separate hostnames keeps the two paths apart by construction.
- A separate process, not a listener in the daemon. A listener attached to the API's app is treated as the main
  one unless every check learns otherwise (`api/credential.ts`); an app of its own inside the daemon fixes that
  on the day it merges and is kept true only by a test. A process has nothing to share: "routes no API" is a
  fact about it, guest traffic can't stall the loop that runs lanes, and the kernel, not the code, keeps it from
  a token. It is also the hardest of these choices to retrofit.
- Files both ways, not a call from the door to the daemon, so the internet-facing process needs no credential
  and the daemon's exposure to a guest is one parse of a small file.
- One hostname per link, not one for every project, so the browser's origin rules separate projects. The
  alternative was clearing site data on the way in, which depends on a header Safari may not honour.
- A dashboard-made, remotely managed tunnel leaves one secret on the Mac that can do one thing. The API route
  would need a token that can edit DNS.
- A child process, not a service: a service would keep the hostname answering while 10db is down and would need
  its own update path.
- Access was left out because an email code is a sign-in for a guest who was promised none, and a broken Access
  rule looks to them like a broken link. It can be added per link later; the door would then check
  `Cf-Access-Jwt-Assertion`.
- Quick tunnels (a new address each run) and ngrok's free plan (a warning page, a request cap) were turned down.
