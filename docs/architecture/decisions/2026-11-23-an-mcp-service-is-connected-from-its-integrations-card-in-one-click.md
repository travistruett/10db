# An outside service an agent reaches through MCP is connected from its Integrations card in one click on every provider

- **Date:** 2026-11-23

## Decision

Linear and Figma are connected from a project's row on their Integrations card with one button, Connect Linear or
Connect Figma, which posts `POST /settings/connect/:service` `{ projectId }`. The daemon adds the service's MCP
server to the builder's own agent config when the project's account can't already sign in to a server at the
service's host, approves it through Trust's Approve (only a server at a `CONNECTABLE_SERVICES` entry's host), and
then:

- **Codex / ChatGPT plan:** one click. The server is added with the pinned `codex mcp add --url` behind a refused
  proxy so it never opens a browser; the account's own OAuth sign-in then opens in the browser.
- **Claude plan, API key or Bedrock:** one click, then `/mcp` in Claude Code. A server already at the host (a
  plugin's, or one in `~/.claude.json`) or the claude.ai connector counts as connected; no duplicate is added.

A new service adds one entry to `ConnectableService` and its label (contracts) and one to `CONNECTABLE_SERVICES`
(daemon), and its card uses `ConnectServiceButton`.

## Why

Each service took several steps across a terminal and Settings pages, and the steps differ by provider. One
button that does every step 10db can do, and says the one it can't, keeps provider parity without asking the
builder to move accounts. A table keyed by service, with approval limited to its own host, keeps "the builder
pressed Connect" from approving anything else.
