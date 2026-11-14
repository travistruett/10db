# apps/daemon/src/runtime-files

- 10db's own dev UI (same decision): with `TENDB_DEV_UI_ORIGIN` set, `/health` names the origin and the API takes a
  second, read-only token (`runtime-files/dev-ui-token.ts`: `<data dir>/dev-ui-token`, 0600, kept across restarts),
  allowed only the GETs `screens/dev-ui-access.ts` names as reads (deny by default; `api/render-reads.test.ts` fails
  on a GET named neither way). `GET /dev-ui/connection` hands it out over the app's own token only, for Open Page.
