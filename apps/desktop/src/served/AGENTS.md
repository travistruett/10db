# apps/desktop/src/served

The phone's app: the window's views under their own entry, frame and router, served by the daemon at `/app/` on the
share listener. It reaches only what a paired device may (`api/auth-matrix.ts`).

- Build: `pnpm --filter @10db/desktop build:app` (`vite.app.config.ts`, page `app.html`, base `/app/`, public files
  in `served-public/`: the manifest, `sw.js` and PNG icons copied from `src-tauri/icons/icon.png`) writes `dist-app/`.
  `prepare-sidecar.ts` runs it first, so the bundle carries it; the daemon finds it through `resolveServedAppDir`.
- See it in a browser with no TLS or pairing: `pnpm dev` (Vite on 1420 answers `/app/...` with `app.html`), then open
  `http://localhost:1420/app/inbox` at about 412 x 915. With no stored device a dev page uses `resolveConnection`'s
  dev token, as the window's browser mode does; a built page with none shows `UnpairedPage`.
- `served-connection.ts`: same-origin connection, token from `device-session.ts` (`localStorage` `tendb.device`:
  device id, token, the Mac's name). Every call goes through `watchedFetch` (`DaemonConnection.fetch`): a 401 on a
  stored device means the Mac removed it, so the token is dropped, the Mac's name kept (`tendb.removedFrom`) and
  the page reloads onto "This device was removed from <Mac>. Pair it again to reconnect." `/events/head` is asked once
  per connect because `/health` answers a revoked token with its public form. The stream takes tickets as the window's
  does (`daemon/events.ts`).
- `pair-page.tsx` / `pairing.ts`: `/app/pair#code=` posts the code to `POST /devices/pair` without a credential, keeps
  the answer, then makes Turn On Notifications its main button (a tap, which Chrome needs to ask; `usePushSwitchFor`
  with a client built from the stored token, since no daemon is connected yet), then Install
  (`beforeinstallprompt`) and Open Inbox. The fragment is cleaned from the address on first read.
- `served-frame.tsx`: the narrow layout with none of the window's chrome (no traffic lights, drag regions or rail):
  views draw into the same `FrameSlotsContext`. A view's panel (the Inbox's list) is a sheet that shows first; picking
  a row closes it. The routes keep the window's ids (`/inbox`, `/factory`, `/settings/$section`) so views that read
  `from: '/inbox'` work. An address the phone lacks says it is in the window.
- Factory is `FactoryGlance`: the window's five figures, read-only, counting Workbench passes as the window does
  (`views/factory/live-passes.ts`). A seeded card with no task is not a run, so "need you" can read 0 beside an
  Inbox of cards: that is the window's number too. Settings is `ThisDevice`: Forget This Device calls
  `DELETE /devices/me`, then clears the token.
- `push-banner.tsx`: on the Inbox, while push is Off (not blocked or unsupported), a card floats over the list
  above the nav with Turn On and a Not Now that keeps it away on this phone (`tendb.pushBannerDismissed`).
- Push (`push-subscription.ts`, the switch on This Device): permission, then `GET /push/key`,
  `pushManager.subscribe`, `PUT /devices/me/push`; off deletes both. It needs the worker (`getRegistration`), so it
  reads "can't show notifications" in a dev page, which registers none.
- `sw.js` keeps the page and `assets/` for no signal and never caches a daemon answer. A push shows the card's kind
  and headline only; a tap opens `/app/inbox/<id>`, which the router turns into the Inbox with that card selected
  (`deep-link.ts` keeps the list sheet from covering it).
- A failed pairing says why in words (`pairingFailureText`), never a status number: 401 the code didn't work, 429
  too many tries, anything else the phone can't reach the Mac.
