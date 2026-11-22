# apps/daemon/src/environment

- An `openrouter` account (kind `openrouter`, `harnessOf` null) holds a key and answers decisions only: it has no config directory, lanes, cap or identity, `launch.ts` refuses it before reading the Keychain (`no harness runs <label> yet`), no project may bind it as account or backup (`requireHarness`, enforced in `@10db/db`), and move targets, list refreshes, model profiles and routing inputs skip it. `GET /accounts/:id/identity` answers 400 for it. `environment/account-secret.ts` is the one check (recorded, present, unchanged) of an account's Keychain secret, read sync by launches and async by the judge.
- `environment/` owns the login env (memory only), the Keychain, the launcher and the system check. `GET /system` answers from the services' last probe (tool versions and `gh api user`'s login, `ToolCheck.signedIn`); `?recheck=1` probes again, and nothing else does. Nothing else reads the login env, and only `launch.ts` names account variables (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, …); other modules use `SECRET_VARIABLES`, `signInCommand`, `Launcher.loginConfigDir()` and `Launcher.loginCodexHome()` (the login shell's absolute `CODEX_HOME`, a protected read through `ProjectAccessDeps.loginCodexHome` like `~/.codex`). Never write the login env or a secret to disk, the database or logs.
- `launch.ts` is the only place that sets or reads `CLAUDE_SECURESTORAGE_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` values: an
  API-key or Bedrock session sets the first to the builder's own entry (`sharedEntryDir`), `session-env.ts` only lists
  both to strip them from the login env, and `connectorProbeEnv` and `staleNeedsAuthCache` are the one rule for the
  connector probe's env and the cache a keyed session clears. A Gateway account never gets the shared entry
  (`docs/architecture/decisions/2026-11-14-mcp-sign-ins-stay-in-each-agents-own-store.md`).
- `Launcher.takeover` is the environment of the builder's own terminal on an account: what to set, which names and
  prefixes to unset from the builder's shell (`BILLING_SWITCH_VARS`, `NESTED_SESSION_VARS`, the kind's dropped login
  variables, minus what the account sets), and where a key is read. It checks a keyed account's secret and holds no
  value: an API key or gateway key is read by the agent's `apiKeyHelper` from `apiKeyHelperAccount`, a Bedrock key
  by the script (`keychain`) with `scrub` set so the agent keeps it from the commands it runs.
