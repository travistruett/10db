# Loopback `http` pages open through a shell command that parses the address, not a capability glob

- **Date:** 2026-11-09

## Decision

The `opener:allow-open-url` scope in `apps/desktop/src-tauri/capabilities/default.json` names no `http` address;
it keeps its three `https` origins. Open Page (workbench spec §4.3, §13) opens a page of the project's dev
server through the shell's own Tauri command, `open_app_page` (`apps/desktop/src-tauri/src/app_page.rs`). The
command parses the address with the `url` crate and opens it only when the scheme is `http` or `https`, it
carries no user name or password, and the host is exactly `localhost`, `127.0.0.1`, `::1` or a name under
`.localhost`, any port and path. It opens the address through the opener plugin's Rust API, which is not held to
the plugin's scope.

`openAppPage(appUrl, route)` in `apps/desktop/src/desktop/tauri.ts` is the one function that calls the command.
Before it does, it requires the app address to be a loopback `http(s)` origin and the address to open to have
exactly that origin, which holds a window to the selected project's own address; otherwise it rejects with
`AppPageRefusedError`. A repo test checks that the capability names no `http` address and that the command is
registered.

## Why

A capability is a static file, so it cannot name one project's address, and the scope's patterns are globs over
the whole URL string. A glob cannot tell a host from the rest: `http://localhost:*` matches
`http://localhost:1@evil.example/`, and `*` matches `/`, so `http://*.localhost/*` matches
`http://evil.example/a.localhost/b`. A webview that is compromised can call the opener plugin directly and skip
any check in the page's JavaScript, so a widened scope would be no boundary at all.

A command in Rust parses the address instead of matching its text, so the host is the host the browser would
use. Only the shell can open a loopback `http` page, and only through a parse that refuses everything else.

Turned down: widening the scope to loopback `http` patterns (the bypass above), allowing any `http` origin
(Open Page would open any web page), and a capability generated per project (the file is static and checked in).
