# Spike 18: Codex on OpenRouter

- **Status:** VERIFIED for a small change, for what Codex reports as its account and provider, for web search and
  for the key reaching Codex's shells. A paid model, a full lane task and a review step are not tried: the
  OpenRouter key Decisions uses is on the free tier with no credit, so every paid model is refused with 402.
- **Date:** 2026-11-21
- **Versions:** codex-cli 0.167.0, macOS 27.2. Model `nvidia/nemotron-3-ultra-550b-a55b:free`, which lists tool
  support.
- **Method:** a scratch `CODEX_HOME` holding only the `config.toml` below, the key read from the Keychain item of
  the builder's OpenRouter account into `OPENROUTER_API_KEY`, and `OPENAI_API_KEY` and `CODEX_API_KEY` unset.
  Turns ran with `codex exec`; `account/read` and `config/read` were sent to `codex app-server` over stdio after
  `initialize`.
- **Design:** `docs/superpowers/specs/2026-11-21-10db-accounts-harnesses-and-sign-ins-design.md`, "OpenRouter runs
  projects on Codex".

```toml
model_provider = "openrouter"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
```

## A small change

Asked to fix `add` in a one-file repository (it subtracted) and check it with `python3`, Codex read the file,
rewrote it, ran the check and reported `5`, in one turn of three shell calls and 17,808 tokens. The Responses API
being stateless did not show: Codex resends the whole turn each request. The model has no metadata in Codex's
catalogue, so Codex warns "Model metadata for `<id>` not found. Defaulting to fallback metadata" as an `error`
item at the start of each turn; the turn still completes. 10db must not treat that item as a failed turn.

A paid model (`openai/gpt-5.6-terra`) was refused before any work: `402 Payment Required: This request requires
more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 874.` Codex retried five
times, then exited 1. A key out of credit therefore surfaces as a 402 in the turn's error, after Codex's own
retries.

## What Codex reports

| Call                      | Result                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account/read`, key set   | `{"account": null, "requiresOpenaiAuth": false}`                                                                                                                                         |
| `account/read`, key unset | the same                                                                                                                                                                                 |
| `config/read`             | `model_provider: "openrouter"`, the provider entry with `env_key: "OPENROUTER_API_KEY"`, `requires_openai_auth: false`, `wire_api: "responses"`, `supports_standalone_web_search: false` |

Codex names no identity for a custom provider, and nothing it reports shows whether the key is set or valid. The
identity check for an OpenRouter account is therefore: `account/read` returns no account and
`requiresOpenaiAuth: false` (a ChatGPT login or an OpenAI key would show as `chatgpt` or `apiKey`), plus the
Keychain key's fingerprint, as for other keyed kinds. `config/read`'s `model_provider` confirms the account's
`config.toml` is the one in effect. A wrong or empty key is found only by the first model call.

## Web search

| `web_search` | Asked the newest post on openrouter.ai/announcements |
| ------------ | ---------------------------------------------------- |
| `cached`     | answered with the live title and date                |
| `live`       | the same                                             |
| `disabled`   | "I don't have access to web browsing tools"          |

Web search works through OpenRouter, but differently from a ChatGPT plan in two ways:

- **No `web_search` item.** The search runs on OpenRouter's side and Codex emits no `web_search` item, only the
  answer. Anything 10db shows or records from those items is empty on OpenRouter.
- **`cached` searches live.** OpenRouter does not honour Codex's cached-only mode; the answer carried a page
  posted five days earlier. On OpenRouter the Web switch's "on" is live web access.

## The key in Codex's shells

With the default `shell_environment_policy`, `printenv OPENROUTER_API_KEY | wc -c` in a Codex shell printed `74`:
the key reaches every command Codex runs. 10db's lane config (inherit nothing) and the takeover's `exclude` list,
which the design calls for, are both required.

## Costs

18 of the key's 50 free requests for the day; $0.014 in spend.
