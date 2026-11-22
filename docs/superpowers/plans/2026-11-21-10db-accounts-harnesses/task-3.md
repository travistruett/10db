# Card 3: OpenRouter's Codex home, key and identity

**Spec:** "OpenRouter runs projects on Codex": the Home, Key and Identity bullets. **Spike:**
`docs/architecture/research/spike-18-codex-on-openrouter.md` (its config, "What Codex reports", "The key in Codex's
shells").
**Track:** A, after card 2, same worktree.

## Files

- `packages/contracts/src/accounts.ts`: `HARNESSES_OF_KIND[AccountKind.OpenRouter] = [Provider.Codex]`.
- `apps/daemon/src/sessions/codex-home.ts`: an OpenRouter account's home gets the template without
  `forced_login_method`, plus `model_provider = "openrouter"` and
  `[model_providers.openrouter] { name = "OpenRouter", base_url = "https://openrouter.ai/api/v1", env_key =
  "OPENROUTER_API_KEY" }`. The home is created like a ChatGPT plan's (its config dir under the account's folder);
  every other line of the template is the same, `shell_environment_policy.inherit = "none"` included.
- `apps/daemon/src/environment/launch.ts`: for an OpenRouter account, read the key from the Keychain at launch
  (`secretOf`) into the Codex process's environment as `OPENROUTER_API_KEY`, and set `CODEX_HOME` to its home. The
  builder's OpenAI and Codex login variables (`CODEX_LOGIN_VARS`, plus `OPENROUTER_API_KEY` from the builder's own
  shell) are dropped for every Codex-harness account (`droppedBy`). The takeover branch does the same.
- `apps/daemon/src/sessions/codex-takeover.ts:149`: `OPENROUTER_API_KEY` joins `shell_environment_policy.exclude`
  for every Codex takeover.
- `apps/daemon/src/sessions/codex-lane-config.ts`: confirm lanes keep `inherit = "none"` and add nothing that would
  pass the key through.
- `apps/daemon/src/sessions/codex-account-read.ts` and `account-check.ts`: `SeenAccount` carries
  `requiresOpenaiAuth`; `credentialsMatch`'s OpenRouter case (below). Identity is the key's fingerprint, as for
  other keyed kinds; `account/read` names no identity, so `expectedIdentity` stays null for OpenRouter.
- The account check (the "Check" button and a launch's check) runs for an OpenRouter account as for a ChatGPT plan,
  with no sign-in step: `signsInWithLogin` stays false for it.

## Interfaces (quoted from the index)

```ts
case AccountKind.OpenRouter:
  return seen.apiProvider === undefined && seen.requiresOpenaiAuth === false;
```

## State-table rows

- OpenRouter session launching / key missing or changed outside 10db → refused as for other keyed kinds.

## Tests

- One test (security, core) that a lane's and a takeover's Codex launch for an OpenRouter account put the key in
  the Codex process's environment and keep it from shells: the lane config's `inherit = "none"` and the takeover's
  `exclude` containing `OPENROUTER_API_KEY`, and the launch env not carrying the builder's `OPENAI_API_KEY`. Use
  the real launcher and config writers with a fake Keychain.
- One case added to the existing `credentialsMatch` table test for OpenRouter (matches with no account and
  `requiresOpenaiAuth: false`; refuses `chatgpt` and `apiKey`).

## Done when

A hand run against the spike's scratch setup is not needed; the tests and checks as card 1 pass.
