# A link in agent text opens any `https:` address, after a native confirm that names the parsed host

- **Date:** 2026-11-13
- **Amends:** `decisions/2026-11-08-the-desktop-opener-opens-artificial-analysis.md`

## Decision

A link in markdown an agent wrote opens any `https:` address the builder confirms. It opens through the shell's own
Tauri command, `open_web_link` (`apps/desktop/src-tauri/src/web_link.rs`), which parses the address with the `url`
crate and refuses anything but `https` with a host and no user name or password. It then asks in a native dialog
titled "Open {host} in your browser?", where the host is the parsed one (punycode for an internationalized name),
with the full address as its message and the buttons Open and Cancel. On Open it opens the address through the
opener plugin's Rust API, which is not held to the plugin's scope, and answers `true`; on Cancel it answers `false`.

The opener's allow list in `apps/desktop/src-tauri/capabilities/default.json` does not change. A repo test checks
that the list is as it was and that the command is registered.

`openWebLink(url)` in `apps/desktop/src/desktop/tauri.ts` is the one function the UI calls. It refuses the same
addresses before it asks anything, rejecting with `WebLinkRefusedError`. In the desktop app it invokes
`open_web_link`; in a plain browser (Vite, the e2e) it asks through a Mantine confirm with the same words
(`conversation/link-confirm.tsx`) and opens a tab cut off from the app.

## Why

An agent's text can carry any address, so a fixed list of hosts cannot serve its links, and a link's text can name
one host while its address names another (`[github.com](https://evil.example/x)`). The confirm names the host the
browser would visit, read from the parsed address, never the text.

A compromised webview could call the opener plugin on any address the scope allows, without any check in the
page's JavaScript. With a scope of `https://*` that would open any page unasked, which is an exfiltration path the
window's CSP closes today. A command in Rust asks natively, so a script in the page can neither skip the confirm nor
word it. This follows `decisions/2026-11-09-the-opener-opens-http-on-loopback-hosts.md`, which opens loopback pages
the same way.

Turned down: widening the scope to `https://*` (it opens without a confirm from any script in the webview), and a
JavaScript confirm in the desktop app (a compromised page skips it).
