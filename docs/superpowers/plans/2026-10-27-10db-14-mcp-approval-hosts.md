# 10db MCP Approvals That Name Hosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An approved repo stdio MCP server reaches the hosts its approval names and no others. A server that downloads its package at start (`npx -y @mantine/mcp-server`) or calls a web API connects in lanes, and `make live-acceptance`'s "repo MCP server connected" check passes.

**Architecture:**

- **The hosts come from a 10db-owned file in the repo, `.10db/mcp-hosts.json`**, which maps a server name from `.mcp.json` to the hosts it may reach. `.mcp.json` has no field for hosts, and Claude Code owns that file's format. The file is plain, schema-checked JSON, so a later Settings editor can read and write it without changing the format (open item).
- **Hosts join the config hash.** A server's hosts, sorted and deduplicated, are hashed with its command, args and env, so any change to them is a new card through the machinery that already re-asks on a changed config. Hosts sitting beside the hash would need a flow to re-approve or revoke that doesn't exist. They enter the hashed form only when there are any, so a server with no hosts keeps its hash and its approval.
- **The approval stores the hosts it covers**, as it stores the variables (`mcp_server_approvals.hosts`, a forward migration: `v0.1.0` is published). A session opens the hosts on the approval row, not on the file. The hash makes the two equal, so the row is the record of what the builder approved.
- **The MCP sandbox opens exactly those hosts** (`allowedDomains`), with `strictAllowlist` on and loopback off as before. The project's hosts are never added.
- **srt's proxy variables reach the server.** srt points its child at its proxy through `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `GRPC_PROXY` and their lower-case forms, whose URLs carry the proxy's token; the launch's inner `env -i` dropped them. It now keeps exactly those names (`NAME="$NAME"`), and the sealed env file sets `NODE_USE_ENV_PROXY=1`. srt itself puts the same values on `env`'s command line for the instant before it execs, so this adds no longer exposure (plan review finding 2: a file in the temp dir was dropped as more machinery for no gain). The server stays srt's own child.
- **Hosts are validated at the boundary** (`McpHost` in `packages/contracts`): a lower-case DNS name of at least two labels, or `*.` followed by one. IP literals, `localhost` and `*.localhost` names, and a wildcard over a single label (`*.com`) are refused.
- **The card names the hosts** and says that anything the server is given, an approved token included, can leave only through them. With none, it says the server reaches no host and that `.10db/mcp-hosts.json` is where hosts are named.

**Tech stack:** TypeScript, zod 4, Drizzle (SQLite), React + Mantine, vitest, srt 0.0.81 under Seatbelt. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-25-10db-lane-sandbox-design.md` D7 ("the hosts its approval card names"), as amended by decision 133 (not the project's hosts, no loopback). Open items: "Sandbox: let an MCP approval name the hosts…" and "Live acceptance: `make live-acceptance` approves `npx -y @mantine/mcp-server`…".

**Built on:** `main` at `6913519`.

## Travis's decisions (2026-10-27)

| # | Question | Decided | Not taken |
|---|---|---|---|
| 1 | Where do the hosts come from? | **A repo side file**, `.10db/mcp-hosts.json`. Travis wants 10db to edit it for the builder later, and later to recommend MCP servers for a project; both are open items, not this plan. | The builder types hosts on the card (needs a hosts input and a re-approve flow); 10db proposes hosts from an `npx` command. |
| 2 | Which host patterns? | **Exact names and a leading `*.` wildcard**, as srt matches them. | Exact names only. |
| 3 | Run the paid live test? | **Yes, once**, after review. | |

## Global constraints

- `.claude/rules/code-style.md` and `.claude/rules/testing.md`; every test is seen red first.
- No silent widening: a host reaches a sandbox only through an approval whose hash covers it.
- `npx` is not recognised anywhere. Hosts for `registry.npmjs.org` are written in the file by a person.
- A file 10db can't parse stops sessions with a flag that says why, as an invalid `.mcp.json` does. A file that names hosts for a server `.mcp.json` doesn't declare as stdio raises a warning card, and those hosts are ignored.

## File structure

| File | Change |
|---|---|
| `packages/contracts/src/system.ts` | `McpHost`; `hosts` on `McpServerReview` and `McpApprovalDto` |
| `packages/db/src/schema.ts`, `src/store/mcp-approvals.ts`, `drizzle/` | `hosts` column, stored and read; generated migration |
| `apps/daemon/src/sessions/mcp-hosts-file.ts` (new) | reads and validates `.10db/mcp-hosts.json` |
| `apps/daemon/src/sessions/project-mcp.ts` | hosts in the review and hash; `hosts` on the approved stdio server |
| `apps/daemon/src/inbox/mcp-approval.ts` | card text; the approval stores the hosts |
| `apps/daemon/src/runner/runner.ts`, `daemon/services.ts` | pass the hosts on; the flag title names both files |
| `apps/daemon/src/sandbox/mcp-sandbox.ts` | `allowedDomains: server.hosts`; srt's proxy variables handed on |
| `apps/daemon/src/sandbox/mcp-sandbox.test.ts`, `apps/daemon/test/mcp-sandbox.seatbelt.test.ts` | an approved host passes srt's proxy; an unapproved one, and every host for a server with none, is refused |
| `apps/desktop/src/views/inbox/mcp-approval.tsx` | a "Reaches these hosts" block |
| `apps/daemon/scripts/live-acceptance.ts` | copies the server's hosts from 10db's own file into the disposable repo |
| `.10db/mcp-hosts.json` | `mantine` → `registry.npmjs.org` (its package) and `mantine.dev` (its docs data, fetched on each tool call) |
| docs | a decision record (format on `main` at PR time), `03-trust-boundaries.md` §4.6, `security.md`, `open-items.md` |

## Tasks

### Task 1: Contracts

- [ ] Table test for `McpHost`: accepts `registry.npmjs.org`, `*.example.org`, `a-b.example.co.uk`; refuses `Example.com`, `localhost`, `foo.localhost`, `*.localhost`, `*.com`, `com`, `127.0.0.1`, `[::1]`, `*`, `*.*.example.org`, `example.org.`, `-a.example.org`, `example.org:443`, `https://example.org`, a name over 253 characters.
- [ ] `McpHost`; `hosts: z.array(McpHost)` on `McpServerReview` and `McpApprovalDto`. Regenerate `packages/contracts/generated/`.

### Task 2: The approval stores its hosts

- [ ] Store test: an approval recorded with hosts reads back with them; a denied one stores none.
- [ ] `hosts` text-JSON column, default `[]`; `pnpm --filter @10db/db generate`; `recordMcpApproval` sets it on insert and conflict.

### Task 3: The side file and the review

- [ ] Tests in `project-mcp.test.ts` (table where it fits): no file → no hosts and the same hash as before; hosts sorted and deduplicated on the review; a change of hosts changes the hash; invalid JSON, an unknown key or an invalid host throws `ProjectMcpError` naming the file and the server; hosts for an undeclared or http server → a warning; `resolveProjectMcp` puts the approval's hosts on the stdio server.
- [ ] `mcp-hosts-file.ts` reads through `readRepoConfigFile`; `readRepoMcp` folds hosts into `normalized`, `reviewOf` and the warnings; `McpApproval` and `ProjectMcpServer` (stdio) carry `hosts`.

### Task 4: The card

- [ ] Tests: the body names the hosts and says a token can leave only through them; with none it says the server reaches no host and names the file; `applyMcpApproval` stores the review's hosts on approve and none on deny. Desktop: the card lists the hosts, or "No host".
- [ ] Implement.

### Task 5: The sandbox opens the hosts

- [ ] `mcp-sandbox.test.ts`: the settings file's `allowedDomains` is the server's hosts, `strictAllowlist` true, no local binding; the launch hands srt's proxy variables on through the server's temp dir and puts none on a command line.
- [ ] Seatbelt test, red first: the probe sends `CONNECT` to srt's proxy (from `HTTPS_PROXY`, credentials URL-decoded) for an approved `.invalid` host, a wildcard match, the wildcard's own domain and an unapproved host; a second server with no hosts tries them all. `.invalid` names never resolve, so the answer is the same online or off. Refused means srt's `blocked-by-allowlist` answer; anything else means the policy let it through, so the test needs no internet.
- [ ] `allowedDomains: server.hosts`; the proxy hand-off.

### Task 6: Live acceptance, the repo's own file, docs

- [ ] `.10db/mcp-hosts.json` with `mantine` → `registry.npmjs.org`; `live-acceptance.ts` writes the server's hosts into the disposable repo and its review check expects them.
- [ ] Decision record; `03-trust-boundaries.md` §4.6; `security.md`; `open-items.md`: close the two items, add "Settings: edit a project's MCP servers and their hosts in 10db" and "MCP: recommend servers for a project".

### Task 7: Gate, review, live test, PR

- [ ] `make gate` prints `GATE PASS` (check `uptime` first).
- [ ] `code-reviewer` on the diff; fix what it finds.
- [ ] `TENDB_LIVE_CLAUDE=1 pnpm --filter @10db/daemon exec vitest run test/lane-sandbox.live.test.ts`, once.
- [ ] Rebase onto `main`, push, open the PR, watch CI.
