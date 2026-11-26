# The phone Inbox (remote host, slice 2)

**Size:** Feature (one page, one implementer end to end, one review that blocks only on bugs). **Spec:**
`docs/superpowers/specs/2026-11-25-10db-remote-host-design.md` §9, with §5.1 (pairing), §5.4 (revoke) and R9 (push
payload). Slice 1 (#877) built the share listener, devices, tickets and the auth matrix; this plan adds no route
class and no migration (`push_subscriptions` exists).

## Brief

**What changes for you.** Devices gets **Pair a Device**: a dialog with a QR code, the 8-character code in large
type, a countdown and New Code. Scan it with your Android phone's camera and Chrome opens
`https://<this Mac>.<tailnet>.ts.net:4319/app/pair`, pairs, and offers Install. The installed app shows your Inbox:
open cards, each card, answer, take back, and a short read-only Factory glance. Its Settings › This Device turns push
on or off and has Forget This Device. With push on, the phone buzzes when a card needs you, with only the card's kind
and the task's headline on the lock screen.

**What it buys.** Answering a permission card, a plan or a check from anywhere your phone has signal (goal G1).

**What could go wrong, and how we'd know.**

- **Push may not arrive** (Chrome's push needs Google Play services). Your 10 minutes at the end finds out. The
  Inbox still works without push.
- **The phone and the Mac disagree on what's worth a buzz.** Both read one rule, moved into contracts, so they can't
  drift.
- **The served app leaks the device token.** It is the desktop UI under a strict CSP with no inline script; agent
  output never renders raw HTML (spec call 3).
- **The e2e harness grows.** The share listener only accepts `https://<fqdn>`, so the phone e2e needs a small TLS
  stand-in for `serve` and a fake Tailscale CLI. If that runs past about 30 minutes I stop and say so.

**Calls you might disagree with** (cost if wrong).

1. **Two pinned dependencies:** `web-push` on the daemon (VAPID and payload encryption) and `qrcode` on the
   desktop. Cost: two more pins to keep current.
2. **VAPID keys live in the login Keychain** under `10db` / `web-push-vapid`, made on the first subscription. Cost:
   a new host means re-subscribing, which pairing does anyway.
3. **The served app is the same React code with its own entry and router** (Inbox, Factory glance, This Device), not
   the whole desktop app. Cost: the phone can't reach other views until slice 3.
4. **`TENDB_TAILSCALE_CLI=<path>`** picks the Tailscale CLI, defaulting to today's search. The e2e points it at a fake;
   it also covers a CLI in an unusual place. Cost: one env var.

**Needed from you:** nothing until the end. Then 10 minutes with your phone: scan, install, allow notifications, see
one buzz. I'll show screenshots of the phone screens before the push work builds on them.

---

## Global constraints

Root `AGENTS.md`, `.claude/rules/code-style.md` and `.claude/rules/testing.md`; the module notes in
`apps/daemon/src/devices/`, `apps/daemon/src/sharing/`, `apps/desktop/src/shell/` and `apps/desktop/src/views/`.
Notes go in the nearest `AGENTS.md`; `apps/desktop/src/views/settings/AGENTS.md` is at its word budget, so its new
note replaces words rather than adding them.

## Per provider

Nothing here touches an account. Every account kind runs as on This Mac: the phone drives the host's daemon, which
runs sessions on the host's credentials. The phone shows no sign-in.

## Parts

1. **Contracts.** Move `shouldNotifyOpened` and `triagedToBuilder` (`apps/desktop/src/desktop/notify-card.ts`)
   into `packages/contracts` as one "worth notifying" module; the desktop imports it. `notify-pass.ts` stays: a
   page-ready notice is a Workbench notice, and push sends asks only (spec §9). Add `PushSubscriptionInput` (endpoint, `p256dh`, `auth`), `PushKeyDto` and `PushPayload`
   (`kind`, `headline`, `inboxItemId`, nothing else, per R9).
2. **Daemon `push/` module.** VAPID keys through `environment/keychain.ts`. `GET /push/key`, and `PUT` and `DELETE
   /devices/me/push`, under the matrix's `Api` row (device only on the share listener). The sender listens to the
   daemon's own Inbox events, applies the contracts rule, and sends one `PushPayload` to each of the builder's
   subscriptions; a 404 or 410 from the push service deletes that subscription. Revoke already deletes them (§5.4).
   `DELETE /devices/me` is Forget This Device: it revokes the calling device.
3. **Served app.** A second Vite build (`vite build --mode app`, `base: '/app/'`, out to `dist-app/`), its entry
   `src/served/`: a connection resolver that is same-origin with the token in `localStorage`, the pair page reading
   `#code=` and calling `POST /devices/pair`, a manifest (`display: standalone`, PNG icons from `app-icon.svg`),
   and a service worker (push shows the notification; a tap opens `/app/inbox/<id>`). The daemon serves `dist-app/`
   for `AppStatic` on the share listener, with a CSP of `default-src 'self'` and no inline script. A 401 drops the
   token and shows "This device was removed from <host>. Pair it again to reconnect."
4. **Phone screens.** The narrow band (`ShellBand.Narrow`) of the existing Inbox view, card, answer and take back;
   a read-only Factory glance; Settings › This Device (push switch, Forget This Device). Reuse the views; add
   nothing that only the phone draws unless the narrow band can't hold it. Screenshots go to the builder here.
5. **Pair a Device** in `devices-section.tsx`: the dialog of §5.5, which closes on `device.changed { change:
   'paired' }`. While sharing isn't Ready, the button says "Finish Remote Access first" (the daemon answers 409).
6. **Docs.** `apps/daemon/src/devices/AGENTS.md` and a new `push/AGENTS.md`; `docs/security.md` gains the push
   payload line.

## Tests

- **One pure test** of the push payload: `PushPayload` from an Inbox item holds only the kind, the headline and the
  id (R9 is a security rule). The moved notify rule keeps any tests it has; it gains none.
- **Extend one e2e** (`apps/desktop/e2e`): at a phone viewport, through the real share listener behind the e2e's TLS
  stand-in, pair with a code from Devices, see a card in the Inbox, answer it, and see it leave. Push is checked by
  hand, not in CI.
- **By hand, 10 minutes** (the builder): install from Chrome, allow notifications, see one buzz. If MagicDNS doesn't
  resolve, set Android's Private DNS to Off or Automatic.
