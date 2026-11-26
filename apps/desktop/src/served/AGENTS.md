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
  the answer, and offers Install (`beforeinstallprompt`). The fragment is cleaned from the address on first read.
- `served-frame.tsx`: the narrow layout with none of the window's chrome (no traffic lights, drag regions or rail):
  views draw into the same `FrameSlotsContext`. A view's panel (the Inbox's list) is a sheet that shows first; picking
  a row closes it. The routes keep the window's ids (`/inbox`, `/factory`, `/settings/$section`) so views that read
  `from: '/inbox'` work. An address the phone lacks says it is in the window.
- Factory is `FactoryGlance`: the window's five figures, read-only. Settings is `ThisDevice`: Forget This Device
  revokes the stored device id through `DELETE /devices/:deviceId`, then clears the token. The notification switch is
  present and off until push exists.
- `sw.js` keeps the page and `assets/` for no signal and never caches a daemon answer.
