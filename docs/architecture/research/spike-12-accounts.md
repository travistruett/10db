# Spike 12: Billing identities per config directory and per keyed kind

- **Status:** IN PROGRESS. The gateway check is VERIFIED; the refresh check is running; Bedrock and API-key
  checks have not run.
- **Date:** 2026-10-18
- **Versions:** claude 2.1.302 (Claude Code) · Agent SDK 0.3.300 · Node v26.12.0
- **Command:** `pnpm --dir spikes/agent-sdk spike:12 <identity | identity-one | refresh | keyed <kind>>`

The checks come from the accounts spec, `docs/superpowers/specs/2026-10-17-10db-accounts-design.md` §10.

## Gateway (`keyed gateway`): VERIFIED

### Question

A gateway account sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. Does the session bill the gateway token,
even when a saved claude.ai login sits in the config directory? What does `accountInfo()` report? Does a
gateway's own model ID reach it through the `model` option?

### Result

Run against OpenRouter (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`), the base URL its Claude Code guide
gives. All six turns succeeded, three with the model alias `haiku` and three with
`SPIKE_MODEL='~anthropic/claude-haiku-latest'`.

- **The token wins over a saved login.** In every case `tokenSource` was `ANTHROPIC_AUTH_TOKEN`: with
  `ANTHROPIC_API_KEY` unset, with it set to an empty string, and with the default config directory, where a
  Claude Max login is saved. OpenRouter's guide says the API key must be empty; unset worked the same. To confirm
  the billing side, the six requests should appear on the OpenRouter account's activity page.
- **A gateway looks like Anthropic.** `apiProvider` was `firstParty` and `apiKeySource` was `none`, the same as a
  subscription session. `email` and `organization` were empty. The only field that tells a gateway session apart
  is `tokenSource`. This answers the spec's open question for gateways: `accountInfo()` reports no organization,
  so identity checks use a fingerprint of the key.
- **A model map is optional on OpenRouter, and it works.** With the alias, `init.model` was
  `claude-haiku-5-5` and OpenRouter served it. With the mapped ID, `init.model` was
  `~anthropic/claude-haiku-latest`, passed through unchanged, and OpenRouter served it.

### Evidence

```
INFO seen gateway, key unset, default config dir (saved login present): {"email":"none","organization":"none","apiProvider":"firstParty","tokenSource":"ANTHROPIC_AUTH_TOKEN","initKeySource":"none","initModel":"claude-haiku-5-5","resultSubtype":"success"}
PASS gateway, key unset, empty config dir: turn succeeded: success
PASS gateway, key empty string, empty config dir: turn succeeded: success
PASS gateway, key unset, default config dir (saved login present): turn succeeded: success
PASS gateway, key unset, empty config dir: init.model equals the requested model: ~anthropic/claude-haiku-latest vs ~anthropic/claude-haiku-latest
PASS gateway, key empty string, empty config dir: init.model equals the requested model: ~anthropic/claude-haiku-latest vs ~anthropic/claude-haiku-latest
PASS gateway, key unset, default config dir (saved login present): init.model equals the requested model: ~anthropic/claude-haiku-latest vs ~anthropic/claude-haiku-latest
RESULT 12-accounts: no failures
```

## Refresh (`refresh`): RUNNING

Four long-lived sessions on one config directory, each sent a one-word turn every 240 s, plus one fresh session
per cycle, for up to 10 hours. The run stops one cycle after the first OAuth refresh line appears in a debug
log, so every session takes a turn on the new token. Claude Code may not log a successful refresh at debug
level; if no line appears, the run lasts the full 10 hours, and every session still succeeding at the end is
the evidence that they survived a refresh. The run started 2026-10-18 at 19:30 Pacific.

## Not yet run

- `identity`: needs two Claude subscriptions.
- `keyed bedrock`: needs `aws sso login` for the profile, then `SPIKE_AWS_REGION` and `SPIKE_AWS_PROFILE`.
- `keyed api_key`: needs an Anthropic API key in the Keychain as `10db-spike` / `api_key`.

## Running the gateway check

Store the token in the login Keychain from a terminal of your own (the prompt needs a real TTY):

```
security add-generic-password -U -s 10db-spike -a gateway -w
SPIKE_GATEWAY_URL=https://openrouter.ai/api pnpm --dir spikes/agent-sdk spike:12 keyed gateway
```
