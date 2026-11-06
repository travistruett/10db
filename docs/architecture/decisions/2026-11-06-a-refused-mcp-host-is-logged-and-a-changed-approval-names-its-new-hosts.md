# A host an MCP server was refused is logged with its name, and a changed approval names the hosts it adds

- **Date:** 2026-11-06
- **Amends:** decision `decisions/2026-10-27-mcp-approval-hosts.md`

## Decision

**The log.** Each repo stdio MCP server is launched with `SRT_DEBUG=1` and `node -r <preload>` before srt's
command line. The preload (`sandbox/mcp-refusals.ts`, a sealed `10db-mcp-<hex>.cjs` beside the server's other
files) wraps `console.error` and `console.warn` in srt's host process. It drops every `[SandboxDebug]`
message, so Claude Code is told what it was before, and appends the host of each `Connection blocked to
<host>:<port>` and `HTTP request blocked to <host>:<port>` to a per-server `10db-mcp-<hex>.log` (mode 0600,
once per host, at most 50). The daemon reads that log every two seconds through the injected `Clock` while the
session lives, and once more when it ends, and logs a warning for each host, once per server, with the fields
`server` and `host` (`REFUSED_MESSAGE` in `mcp-sandbox.ts`). The sandbox's stale-file sweep names the new
suffixes.

**The card.** When a server's config changed and the builder approved an earlier one, the approval card names
the hosts the earlier approval did not open (`New hosts since your last approval: …`) and those it no longer
does (`No longer reached: …`). `getLatestApprovedMcpApproval` finds that approval by server name, whatever
its config hash. The hosts were already part of the config hash, so a changed list already raised a new card;
now the card says what changed.

**Where hosts come from** is unchanged: `.10db/mcp-hosts.json` in the project's repo, which the builder edits.
10db has no built-in table of hosts per package.

## Why

On 2026-11-06 the `credits` tool of `awslabs.billing-cost-management-mcp-server@0.0.44` failed with a proxy
error while its other tools worked. Its clients take botocore's endpoint ruleset, which sends `billing`,
`invoicing`, `freetier` and `bcm-pricing-calculator` to `<service>.us-east-1.api.aws`, not the
`<service>.us-east-1.amazonaws.com` names the project's file listed, and two clients (`compute-optimizer-automation`,
`billingconductor`) were not listed at all. srt refused the real host, and nothing said which: its proxy
reports a refusal only in its debug log, which goes to the stderr Claude Code keeps for the server.

The log needed a channel the daemon owns. Claude Code's handling of an MCP server's stderr is not something
10db controls or can see, so the preload takes the one line that matters out of srt's host, and keeps the rest
of srt's debug output off stderr, where it held the settings and the command line. A poll, not a file watch,
because FSEvents is not always reachable and the log is small. A host from the sandboxed server is written
by srt, not by the server, but the daemon reads the file as untrusted anyway: a line that is not a host name is
dropped.

A table of AWS hosts keyed by package would have fixed this project without a change to its repo, but it makes
10db vouch for hosts, which is the builder's call; the builder chose to keep the list in the repo file.
