# Spike 17: What each account says it can run, and whether a listed model launches

- **Status:** VERIFIED for the Claude subscription and for ChatGPT's model list. PARTIAL for Bedrock: the list was read,
  but no launch ran, because the cloud credentials had expired.
- **Date:** 2026-11-06
- **Versions:** Claude Code 2.1.319, Agent SDK 0.3.316, codex-cli 0.154.0, macOS 27.2. models.dev fetched the same day:
  235 providers, 5.96 MB.
- **Method:** a throwaway script. A `query()` with an idle prompt channel, `settingSources: []` and
  `strictMcpConfig: true`, then `supportedModels()` with no prompt sent. Launches sent "Reply with the single word OK."
  with `maxTurns: 1` and `tools: []`. Codex's list came from `model/list`, with no prompt sent.
- **Design:** `docs/superpowers/specs/2026-11-06-10db-model-catalogue-design.md`

## Subscription: the list

`supportedModels()` on a Claude Ultra plan returns five rows.

| value                  | resolvedModel     | efforts                   |
| ---------------------- | ----------------- | ------------------------- |
| `default`              | claude-opus-5-5   | low medium high xhigh max |
| `opus`                 | claude-opus-5-5   | same                      |
| `claude-fable-5-1[1m]` | claude-fable-5-1  | same                      |
| `sonnet`               | claude-sonnet-5-5 | same                      |
| `haiku`                | claude-haiku-5-5  | same                      |

Every `resolvedModel` is an exact ID under models.dev `anthropic`. `default` duplicates Opus. The other keys on a row
are `displayName`, `description`, `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`,
`supportsFastMode` (Opus only), `supportsAutoMode` and `supportsThinkingOff`.

## Subscription: launches by concrete ID

| requested              | init.model        | modelUsage key    | context | result                                           |
| ---------------------- | ----------------- | ----------------- | ------- | ------------------------------------------------ |
| `haiku`                | claude-haiku-5-5  | claude-haiku-5-5  | 1000000 | OK                                               |
| `claude-haiku-5-5`     | claude-haiku-5-5  | claude-haiku-5-5  | 1000000 | OK                                               |
| `sonnet`               | claude-sonnet-5-5 | claude-sonnet-5-5 | 1000000 | OK                                               |
| `claude-sonnet-5-5`    | claude-sonnet-5-5 | claude-sonnet-5-5 | 1000000 | OK                                               |
| `opus`                 | claude-opus-5-5   | claude-opus-5-5   | 1000000 | OK                                               |
| `claude-opus-5-5`      | claude-opus-5-5   | claude-opus-5-5   | 1000000 | OK                                               |
| `claude-opus-5-5[1m]`  | claude-opus-5-5   | claude-opus-5-5   | 1000000 | OK                                               |
| `claude-fable-5-1`     | claude-fable-5-1  | claude-fable-5-1  | 1000000 | OK                                               |
| `claude-fable-5-1[1m]` | claude-fable-5-1  | claude-fable-5-1  | 1000000 | OK                                               |
| `default`              | claude-opus-5-5   | claude-opus-5-5   | 1000000 | OK                                               |
| `not-a-model`          | not-a-model       | none              | n/a     | `model_not_found` at the first assistant message |

A subscription launches by concrete ID with the same context window as the alias, and `init.model` equals the concrete
ID. `init.model` drops `[1m]`, so a launch ID that keeps that suffix would fail the adapter's `modelMatches` check.

## Bedrock: the list

With `CLAUDE_CODE_USE_BEDROCK=1` in `us-east-1`, `supportedModels()` returns 14 rows. `value` equals `resolvedModel`
except for two aliases.

| value                                        | resolvedModel                               | efforts reported |
| -------------------------------------------- | ------------------------------------------- | ---------------- |
| `default`                                    | us.anthropic.claude-opus-5-5                | yes              |
| `us.anthropic.claude-fable-5-1`              | same                                        | yes              |
| `us.anthropic.claude-sonnet-5-5`             | same                                        | yes              |
| `us.anthropic.claude-sonnet-5`               | same                                        | yes              |
| `us.anthropic.claude-sonnet-4-6`             | same                                        | no xhigh         |
| `us.anthropic.claude-sonnet-4-6[1m]`         | same                                        | no xhigh         |
| `us.anthropic.claude-opus-4-1-20250805-v1:0` | same                                        | none             |
| `us.anthropic.claude-opus-5-5`               | same                                        | yes              |
| `us.anthropic.claude-opus-5`                 | same                                        | yes              |
| `us.anthropic.claude-opus-4-8`               | same                                        | yes              |
| `us.anthropic.claude-opus-4-7`               | same                                        | yes              |
| `us.anthropic.claude-opus-4-6-v1`            | same                                        | no xhigh         |
| `us.anthropic.claude-opus-4-6-v1[1m]`        | same                                        | no xhigh         |
| `haiku`                                      | us.anthropic.claude-haiku-4-5-20251001-v1:0 | none             |

Every ID is exact under models.dev `amazon-bedrock`, except the two `[1m]` rows, which join once the suffix is
stripped. Haiku 5.5 is not listed, though models.dev has `us.anthropic.claude-haiku-5-5`. The list works with expired
AWS credentials, so it is not a live read of the account: it is Claude Code's built-in view of Bedrock.

## Bedrock: launches are not proven

The AWS SSO token had expired, so every launch stopped at `cloud_credential_error`. `init.model` still shows how each
request resolves, which is not proof that the model runs.

| requested                        | init.model                                        |
| -------------------------------- | ------------------------------------------------- |
| `haiku`                          | us.anthropic.claude-haiku-4-5-20251001-v1:0       |
| `us.anthropic.claude-haiku-5-5`  | us.anthropic.claude-haiku-5-5                     |
| `sonnet`                         | us.anthropic.claude-sonnet-4-5-20250929-v1:0      |
| `us.anthropic.claude-sonnet-5-5` | us.anthropic.claude-sonnet-5-5                    |
| `opus`                           | us.anthropic.claude-opus-5-5                      |
| `claude-opus-5-5`                | claude-opus-5-5 (an unprefixed ID passes through) |
| `us.anthropic.claude-fable-5-1`  | us.anthropic.claude-fable-5-1                     |

The `sonnet` alias resolves to Sonnet 4.5 on Bedrock unless `ANTHROPIC_DEFAULT_SONNET_MODEL` is set, while the list
offers Sonnet 5.5.

## ChatGPT plan: Codex `model/list`

On a ChatGPT Pro account, with no prompt sent:

| model           | hidden | default | efforts                         |
| --------------- | ------ | ------- | ------------------------------- |
| `gpt-6-astra`   | false  | yes     | low medium high xhigh max ultra |
| `gpt-5.6-sol`   | false  |         | low medium high xhigh max ultra |
| `gpt-5.6-terra` | false  |         | low medium high xhigh max ultra |
| `gpt-5.6-luna`  | false  |         | low medium high xhigh max       |

Every ID is exact under models.dev `openai`. `ultra` is outside 10db's `Effort`, so it is dropped.

## Tier rule against models.dev prices

Output price in USD per million tokens, with each model's share of the priciest in its set.

| Offered set                                     | Result                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Subscription                                    | Fable 50 Strongest; Opus 5.5 20 (40%) Strongest; Sonnet 5.5 10 (20%) Balanced; Haiku 5.5 0.5 (1%) Fast              |
| ChatGPT today                                   | Astra 50 Strongest; 5.6 Sol 20 (40%) Strongest; 5.6 Terra 12 (24%) Balanced; 5.6 Luna 1.2 (2.4%) Fast               |
| Bedrock alone                                   | Fable and Opus 5.5 Strongest; Sonnet 5.5 Balanced; Haiku 4.5 5 (exactly 10%) Fast; older Opus and Sonnet Superseded |
| Subscription and Bedrock                        | as Subscription; Haiku 4.5 is Superseded, so the Bedrock account has no Fast model                                  |
| ChatGPT if Codex moves to the newest GPT models | Astra 50 Strongest; 6.1 Sol 10 (20%) Balanced; 6.1 Terra 5 (10%) Fast; 6 Luna 0.5 (1%) Fast                         |

The expected tiers hold today: Fable and Opus Strongest, Sonnet Balanced, Haiku Fast; Astra and Sol Strongest, Terra
Balanced, Luna Fast. models.dev already lists `gpt-6.1-sol`, `gpt-6.1-terra` and `gpt-6-luna`, which Codex does not yet
offer.

## models.dev data notes

- Statuses in the four kept providers are `deprecated` or absent.
- `openai` has 3 entries with no `cost`, and `openrouter` has 4. 38 OpenRouter entries have no `family`.
- There is no maker field. A model under `anthropic` or `openai` has that provider as its maker.

## Traps

1. **A listing does not prove the account is signed in.** With `env -i` keeping only `HOME` and `PATH`, the process is
   signed out (`tokenSource: none`, `Not logged in`), yet `supportedModels()` still answers and `init.model` still
   reports the requested model. Only the assistant message fails, with `authentication_failed`. Keeping `USER` and
   `LOGNAME` signs it in: keychain access needs them.
2. **`init.model` does not prove a model exists.** `not-a-model` reported `init.model: not-a-model` and failed only at the
   first assistant message, with `model_not_found`.
3. **The Bedrock list is not a read of the account.** It answers with expired credentials.
4. **Bedrock aliases resolve to older models than the list offers.** `sonnet` is Sonnet 4.5, and `haiku` is Haiku 4.5.

## What this means for the catalogue work

- **Join to models.dev by exact ID.** Every subscription and ChatGPT ID, and every Bedrock ID once `[1m]` is stripped,
  is a key under its models.dev provider. No alias table is needed for those accounts.
- **Launch by concrete ID.** A subscription runs `claude-sonnet-5-5` as it runs `sonnet`, with the same context window,
  and `init.model` equals the concrete ID. The launch ID must not carry `[1m]`, or `modelMatches` fails and the launch is
  refused as `BillingRefused` at `claude-adapter.ts:704`.
- **Do not treat a listing or an `init.model` as proof.** Whether the account is signed in comes from the billing check,
  and whether a model exists comes from a first assistant message.
- **Bedrock launches stay unproven.** Until a launch runs with live credentials, a Bedrock kind should be treated as
  listed, not verified. Aliases there must not be relied on: `sonnet` and `haiku` resolve to 4.x models.
- **Haiku 5.5 is missing from the Bedrock list.** Bedrock alone has Haiku 4.5 as its only Fast model, and with a
  subscription alongside, Haiku 4.5 is Superseded, so a Bedrock account can have no Fast model. A role that wants Fast
  must fall back, as the role-default path does when an account offers none.
- **A kind with no `resolvedModel` takes the no-list rule.** It does not stop the build.
- **`default` duplicates Opus.** The catalogue should drop rows whose `resolvedModel` repeats another's.
- **`deriveTiers` must filter to offered models first,** then take the newest per family. Otherwise the 5.6 models are
  all superseded by `gpt-6.1-*` models that the account cannot run.
- **Effort lists differ per row.** Bedrock's older Sonnet and Opus lack `xhigh`, and some rows report none, so efforts
  come from each row and `ultra` is dropped.
- **models.dev has gaps.** Entries with no `cost` or no `family` must be tolerated, and a maker is its provider.

## Not verified

- A Bedrock launch of any model with live credentials, and so whether `us.anthropic.claude-sonnet-5-5` and the other
  concrete IDs run.
- Whether a gateway account lists its models the same way.
- A launch of a Codex model by the model IDs `model/list` returns, beyond the listing.
