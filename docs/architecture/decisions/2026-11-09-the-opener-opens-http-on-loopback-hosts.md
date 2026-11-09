# The desktop opener allows `http` on loopback hosts, and the window holds it to the project's address

- **Date:** 2026-11-09

## Decision

The `opener:allow-open-url` scope in `apps/desktop/src-tauri/capabilities/default.json` gains `http` URL
patterns for loopback hosts only: `localhost`, `127.0.0.1`, `[::1]` and names under `.localhost`, each with any
port and any path. No other `http` origin is allowed, and the three `https` origins stay as they were.

`openAppPage(appUrl, route)` in `apps/desktop/src/desktop/tauri.ts` is the one function that opens such an
address. It opens a URL only when the app address is a loopback `http(s)` origin and the URL's origin equals it;
otherwise it rejects with `AppPageRefusedError`. A repo test checks that the capability names `http` only for
these hosts.

## Why

Open Page (workbench spec §4.3, §13) opens a page of the project's dev server in the builder's browser, and
that server answers on a loopback `http` address. A capability is a static file, so it cannot name one
project's address; it can only name the class of addresses a project may have. The check that the address is
the selected project's own therefore lives in the window, in the function that calls the opener, where the
project's app address is known.

The scope's patterns are globs matched against the whole URL string, so `http://localhost:*` also matches a
string such as `http://localhost:1@other.example/`. The capability alone is therefore a coarse bound; the
window's check parses the address and compares origins, which refuses such strings, and nothing else in the app
calls the opener with an `http` address. `[` is a glob character, so `[::1]` is written `[[]::1]`.

Turned down: allowing any `http` origin (Open Page would open any web page), and a capability generated per
project (the file is static and checked in).
