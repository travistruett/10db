# MCP sign-ins stay in each agent's own store, and 10db never touches a token

- **Date:** 2026-11-14
- **Amends:** decision 105

## Decision

An MCP server that signs in with OAuth works in a 10db session through the sign-in its own agent keeps. 10db
never reads, copies, logs or stores a token, a keychain entry's data or a `.credentials.json`.

- **Claude plan.** The session reads the builder's entry as Claude Code does: an account on the default folder
  or the login shell's folder already does. An account on a folder of its own has its own entry, which the
  builder signs in from a terminal (`CLAUDE_CONFIG_DIR=<dir> claude`, then `/mcp`); Settings shows the command.
- **Claude API key and Bedrock.** The session sets `CLAUDE_SECURESTORAGE_CONFIG_DIR` to the login shell's
  `CLAUDE_CONFIG_DIR`, or to the empty string for Claude Code's default folder, so its keychain lookup meets the
  builder's own entry, as the builder's Claude Code does when switched to Bedrock.
  - Such a session may also refresh the plan's stored login (`claudeAiOauth`) in that entry, as the builder's own
    Claude Code does.
  - The check before the prompt and the check at `init` refuse a session that is not billing the key, or not on
    Bedrock. Neither compares plan names.
  - The login shell's own `CLAUDE_SECURESTORAGE_CONFIG_DIR` is stripped like a billing switch, so only
    `environment/launch.ts` decides it.
- **Claude Gateway** gets none of this. Nothing proves the plan's bearer never reaches a gateway's own address,
  so its OAuth servers are named as not run there yet, and a follow-up task is filed.
- **Codex.** Tokens go in a file in the account's own home (`mcp_oauth_credentials_store = "file"`), which under
  10db's empty home is where Codex's own fallback lands anyway. Settings › Trust signs an account in with Codex's
  own login (`mcpServer/oauth/login` on an ephemeral thread that carries the one server); 10db only opens the
  https page Codex names, with `/usr/bin/open`, and the window never learns to open a page.
- **A session that finds a server signed out** says where to sign in. 10db holds no sign-in status for Claude
  accounts.

## Why

The alternatives were copying tokens between stores, or signing the builder in again for each account. Copying
puts a secret in 10db's hands and breaks when an agent rotates it; signing in again per account asks the builder
for a step Claude Code and Codex don't ask for. Each agent already keeps, refreshes and rotates its own tokens,
so leaving them there is the smallest design that works on every account kind and keeps the rule that no
credential reaches a lane.

The cost is a shared keychain entry between a keyed session and the plan login. A keyed session that refreshes
the plan's login is what the builder's own Claude Code does on Bedrock; the live rows check the entry holds a plan
login first and that the keyed folder never gets an `oauthAccount`.
