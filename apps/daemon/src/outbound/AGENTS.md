# outbound

The one `fetch` the daemon makes outbound calls with.

- `outboundFetch` passes one shared undici `Agent({ allowH2: false })` as the dispatcher, so the daemon never
  opens an HTTP/2 session
  (`docs/architecture/decisions/2026-11-26-the-daemon-fetches-over-http-1-until-node-26-fixes-aborted-h2-streams.md`).
  Never set the built-in dispatcher through its global Symbol.
- ESLint refuses the global `fetch` as a value anywhere else in `apps/daemon/src` (`eslint.config.js`); a module
  takes a `fetch` from its caller or imports this one. `typeof fetch` as a type is fine.
- `isOutboundTransportError` is what `main.ts` logs instead of exiting on.
