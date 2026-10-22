# Spike 12: Billing identities per config directory and per keyed kind

- **Status:** IN PROGRESS. The gateway check is VERIFIED; the refresh check is PARTIAL and deferred (an open
  question in `docs/architecture/open-questions.md`); Bedrock, API-key and two-subscription checks have not run.
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

## Refresh (`refresh`): PARTIAL

### Question

Do four concurrent sessions on one config directory survive an OAuth token refresh (spec §10 check 2, Claude Code
issues 54443 and 61923)?

### Result

Four long-lived sessions on one config directory each took a one-word turn every 240 s, and one fresh session
started per cycle, for the full 10 hours: 149 cycles, 596 turns in the long-lived sessions and 149 fresh sessions,
from 19:30 to 05:29 Pacific. Every turn succeeded. No session failed, and the sign-in was still valid at the end.

The refresh itself was not observed. No line in the five debug logs mentions an OAuth refresh, a 401, an expired
token or a credential change, so Claude Code does not log a successful refresh at debug level, and the run's
early stop never fired. If an access token lasts less than 10 hours, a refresh happened during the run and every
session rode through it; the run does not show how long a token lasts. Nothing broke, but the run does not rule
out the refresh race either, so the spec's fallbacks (a lane cap, or starting sessions one at a time) stay
available until the check is rerun.

### Finishing the check (deferred)

Claude Code logs nothing about credentials at debug level, and `claude auth status` reports no expiry. The rerun
reads the config directory's stored credential in process each cycle and records only its `expiresAt` and a
short hash of the access token, never the token. A change in either marks the refresh and its time, and the run
stops one cycle later. The first cycle's `expiresAt` also shows how long a token lasts.

### Evidence

```
INFO cycle 149: {"at":"2026-10-19T12:29:07.152Z","turns":[149,149,149,149],"laneFailures":[0,0,0,0],"fresh":"success","refreshLines":[0,0,0,0],"refreshFailures":[0,0,0,0]}
PARTIAL a token refresh happened during the run: no refresh lines in any debug log; extend SPIKE_HOURS
PASS no lane failed a turn: [[],[],[],[]]
PASS no fresh session failed: 0 of 149
PASS no refresh failures logged: [0,0,0,0]
RESULT 12-accounts: no failures
```

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
