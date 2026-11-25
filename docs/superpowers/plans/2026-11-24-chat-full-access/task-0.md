# Task 0: spike the unknowns, live

Read the index's Brief and Global Constraints first. No code lands from this task; write its answers into the
index under a "Spike answers" heading, and delete the scratch script.

**Claude.** From a scratch script on this Mac, start an SDK `query()` with `settingSources:
['user','project','local']`, `strictMcpConfig: false`, no `sandbox`, `permissionMode: 'auto'`, cwd a repository
with a `CLAUDE.md` and a `.mcp.json` server, with the builder's plugins installed. Run it twice: on the default
config folder (the builder's plan) and with `CLAUDE_CODE_CONFIG_DIR`/`CLAUDE_CONFIG_DIR` set to a keyed account's
folder from `sessionConfigDir` (`apps/daemon/src/environment/launch.ts`) with `apiKeyHelper` in inline settings.
Answer:

1. Does the project's `.mcp.json` server start, or wait on an approval nobody can give in the SDK? If it waits,
   task 2 passes approved project servers over `setMcpServers`, unsandboxed.
2. On the default folder, do `CLAUDE.md` and each plugin's skills load once?
3. Do `setMcpServers` servers (10db's `/mcp`) add to the loaded ones or replace them?
4. With `apiKeyHelper`, what do the init message's `apiKeySource` and `apiProvider` say? Task 2's account check
   accepts exactly that.

**Codex.** Send `thread/start` with `sandbox: 'danger-full-access'` on 10db's Codex home, whose
`default_permissions` is `lane`. Which wins, and on `thread/resume`? If the home wins, task 3 sets the thread's
`config.permissions` itself.
