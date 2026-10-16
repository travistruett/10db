# Spike 01: The SDK runs the installed claude with user settings excluded

- **Status:** VERIFIED
- **Date:** 2026-10-15
- **Versions:** claude 2.1.300 (Claude Code) · Agent SDK 0.3.299 · Node v25.2.1
- **Command:** `pnpm --dir spikes/agent-sdk spike:01`

## Question

The Agent SDK runs the installed `claude` via `pathToClaudeCodeExecutable`, with user settings excluded.

## Result

The SDK drove the installed binary (`~/.local/bin/claude`, from `which claude`): `init.claude_code_version` was
2.1.300, the same as `claude --version`. With the allowlisted child env, all three sessions billed the
subscription: `apiKeySource: none`, `apiProvider: firstParty`, `subscriptionType: "Claude Max"`. `tokenSource`
was not reported (`unknown`). `subscriptionType` is a display string ("Claude Max"), not the enum-like `max`. With
a session open and no prompt sent, `accountInfo()` answered in 587 ms with `apiProvider: firstParty` and
`subscriptionType: "Claude Max"`; no `init` message arrived before the session was closed.

| `settingSources`      | Plugins         | MCP servers | Memory files        | Project hook | Local hook    |
| --------------------- | --------------- | ----------- | ------------------- | ------------ | ------------- |
| `['project']`         | 3 built-in only | none        | fixture `CLAUDE.md` | ran          | did not run   |
| `[]`                  | 3 built-in only | none        | none                | did not run  | did not run   |
| `['project','local']` | 3 built-in only | none        | fixture `CLAUDE.md` | ran          | ran (control) |

None of the user's `~/.claude/skills` loaded. Under every setting, the same 19 skills built into the binary
appeared (`deep-research`, `design`, `design-sync`, `dataviz`, `update-config`, `verify`, `debug`, `code-review`,
`simplify`, `batch`, `fewer-permission-prompts`, `doctor`, `loop`, `schedule`, `claude-api`,
`workflow-authoring`, `run`, `run-skill-generator`, `plugin-authoring`). So did three plugins built into the
binary, all with `path: "builtin"`: `cc-plugin-agents-md`, `cc-plugin-telemetry` and
`cc-plugin-plugin-authoring`. `settingSources` does not remove them. The probe's plugin check was narrowed to
"no user or marketplace plugins" for that reason.

## Evidence

```
INFO auth: {"provider":"firstParty","apiKeySource":"none","subscriptionType":"Claude Max","tokenSource":"unknown"}
PASS init received: model=claude-haiku-5-5
PASS claude version matches installed binary: 2.1.300 vs 2.1.300 (Claude Code)
INFO built-in plugins (always loaded): ["cc-plugin-agents-md","cc-plugin-telemetry","cc-plugin-plugin-authoring"]
PASS no user or marketplace plugins loaded: []
PASS no MCP servers loaded (strictMcpConfig): []
PASS no user skills loaded: []
PASS no user CLAUDE.md loaded: ["/private/var/folders/…/tendb-spike-4ZcSrJ/CLAUDE.md"]
PASS project CLAUDE.md loaded: ["/private/var/folders/…/tendb-spike-4ZcSrJ/CLAUDE.md"]
PASS project settings loaded (project hook ran): hook frames: 2
PASS local settings excluded (local hook did not run): settings.local.json can switch billing, so it must never load
PASS []: project settings excluded: hook frames: 0
PASS []: project CLAUDE.md excluded: []
PASS control: the local canary fires when local is loaded: if this fails, the local-exclusion check above proves nothing
INFO accountInfo before any prompt: {"ms":587,"apiProvider":"firstParty","subscriptionType":"Claude Max","initSeen":false,"messages":2,"cost":null}
PASS accountInfo answers before any prompt is sent (within 15 s): 587 ms
RESULT 01-runtime: no failures
```

The block above is verbatim from the last run, which added the `accountInfo` check. The first run had one FAIL, `no plugins loaded`, caused by the three built-in plugins above. Each turn's
`total_cost_usd` estimate was under $0.002.

## Consequence for M1

M1b Claude adapter: `pathToClaudeCodeExecutable` is the captured `which claude`, with
`settingSources: ['project']` and `strictMcpConfig: true`. The repo's own `.claude/settings.json` and `CLAUDE.md`
load, and project command hooks run in SDK mode with no trust prompt. User and local settings never load. The
subscription login reports `apiKeySource: none` with `apiProvider: firstParty`, and that is the adapter's billing
check. `subscriptionType` is a display string, so M1b checks that it is non-empty and never compares it to `max`. `accountInfo()`
answered in 587 ms before any prompt was sent (and `init` does not arrive until a prompt is sent), so M1b's billing
preflight can run before the prompt as designed.
Built-in skills and plugins always load, so M1b can't assume an empty `init.plugins`.

Caveat from spike 3: `~/.claude/settings.json` stays out (its `enabledPlugins` and `Stop` hook never appeared),
but a preference in the global config `~/.claude.json` (`autoCompactEnabled: false`) still reached the session.
M1b sets every behavior it depends on explicitly in `Options.settings` and doesn't rely on defaults.
