# apps/daemon/src/push

Web Push to paired phones when a card needs the builder.

- `vapid-keys.ts`: the host's VAPID key pair, one secret (`<public>.<private>`, base64url: the Keychain refuses quotes) in the login Keychain (service `10db`, account
  `web-push-vapid`). `ensure()` makes it on the first subscription or the first `GET /push/key`; `read()` never makes
  one, so the sender on a Mac nobody subscribed on touches no Keychain item. A new Mac makes its own, and a phone
  then subscribes again, which pairing does anyway.
- `push-service.ts` backs `GET /push/key`, `PUT /devices/me/push` and `DELETE /devices/me/push` (`PushRoutes` in
  `api/app.ts`, which the desktop typechecks, so the interface lives there and this module implements it). One
  subscription per endpoint (`upsertPushSubscription`); revoking a device deletes its own (`packages/db`).
- `push-sender.ts` listens on the daemon's own bus for `inbox.opened` and a triage that left the card with the
  builder, builds the payload with `pushPayloadOf` (`@10db/contracts`, the rule the desktop's notification shares:
  `shouldNotifyOpened`, not a Workbench page-ready card) and sends it to every subscription. A 404 or 410 from the
  push service deletes the subscription; any other failure is logged by status only (never the endpoint) and the next
  card tries again. `send` is injected; the default is `web-push`.
- **The payload is the card's kind, its headline (120 characters) and its id, nothing else** (R9, spec §5.4): a lock
  screen is public. `PushPayload` is a strict object, and `push.test.ts` in contracts keeps a body, option or path
  out of it.
- **Endpoints are allowlisted** (`PUSH_SERVICE_HOSTS`, `isPushServiceEndpoint` in contracts): https on 443 at
  `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com` or `*.notify.windows.com`, no
  credentials in the URL. The daemon POSTs to whatever endpoint a device stores, and a paired device is not trusted
  with the Mac's network, so without the list it could aim the daemon at loopback or a private address (SSRF). The
  schema refuses a bad endpoint on the PUT (400) and the sender checks again before each send, deleting a row that
  got there another way.
- `web-push.d.ts` types the three exports used (the package ships none, and `@types/web-push` drags in a second
  `@types/node` the desktop's typecheck of `api/` then trips on).
