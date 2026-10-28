# An MCP server's approval names the hosts its sandbox opens

- **Date:** 2026-10-27
- **Amends:** decision 133, and lane sandbox spec D7

## Decision

A repo stdio MCP server reaches the hosts its approval names and no others. The repo names them in
`.10db/mcp-hosts.json` (`{ "servers": { "<name>": { "hosts": [...] } } }`), which 10db reads next to
`.mcp.json` with the same file checks (`sessions/mcp-hosts-file.ts`). A host is a lower-case DNS name of at
least two labels, or `*.` and such a name, which srt matches as every subdomain and not the name itself
(`McpHost` in `packages/contracts`). An IP address, a port, `localhost` and any `.localhost` name are refused,
and so is a wildcard over one label. A file 10db can't parse stops sessions with a flag, as an invalid
`.mcp.json` does; hosts named for a server `.mcp.json` doesn't declare as stdio raise a warning card and are
ignored.

A server's hosts, sorted and once each, are part of its config hash, so naming another host is a new card.
They enter the hashed form only when there are any, so a server with no hosts keeps the hash, and the
approval, it had before. The approval card lists the hosts and says that whatever the server is given, an
approved token included, can leave only through them; the approval row stores them as it stores the
variables, and a session opens the hosts on the row. The MCP sandbox's `allowedDomains` is that list: not the
project's hosts, with `strictAllowlist` on and no loopback, as decision 133 has it.

srt points its child at its proxy through `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`,
`GRPC_PROXY` and their lower-case forms. The launch's inner `env -i` keeps exactly those names, and the
sealed env file sets `NODE_USE_ENV_PROXY=1` so Node's own `fetch` uses the proxy. A client that ignores the
proxy variables and dials out itself is refused by Seatbelt.

## Why

`.mcp.json` is Claude Code's format and has no field for hosts, so the hosts live in a file 10db owns. The
builder typing hosts on the card would need an input there and a flow to change an approval later, which
doesn't exist; a repo file reaches every clone, and any change to it asks again through the card machinery
that re-asks on a changed config. Recognising `npx` to open the npm registry by itself would be the check for
misuse decision 133 turned down; here a person writes the registry in the file and the builder approves it.
Travis wants 10db to edit this file for the builder later, and to recommend servers for a project; both are
open items.

Refusing `localhost` names and IP addresses in the file is the first check, not the only one: a name's DNS
can point anywhere. srt's proxy resolves an allowed name once, refuses it when an address is loopback,
unspecified, link-local, multicast, a cloud metadata endpoint or one of this Mac's own, and dials the address
it checked, so a rebinding answer gains nothing (`resolved-address-guard.js`, on by default and left so).
Private ranges (RFC 1918, ULA) are not refused, as for lanes and the gate: an approved name that resolves into
the local network reaches it.

Hosts sitting beside the hash would widen an approval silently when the file changed. Keeping the hash of a
hostless server unchanged spares every existing approval a second card. The row keeps the hosts so the record
says what the builder approved, as it does for variables.

srt itself hands its proxy variables, its proxy token among them, to `env` on a command line for the instant
before `env` execs. Keeping them by name in the inner `env -i` puts them on its command line for the same
instant and adds no longer exposure; a file in the server's temp dir would have meant a second sealed file
for no gain. `test/mcp-sandbox.seatbelt.test.ts` measures the policy with `CONNECT` requests to srt's proxy
for `.invalid` names, so the answer doesn't depend on the network: srt refuses a host off the list with its
`blocked-by-allowlist` mark before any lookup, and lets a listed one through.
