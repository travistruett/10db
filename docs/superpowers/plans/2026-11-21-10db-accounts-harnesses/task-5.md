# Card 5: the judge asks Anthropic's API and Bedrock

**Spec:** "Decisions on any API account": the `judge.choose` bullet and its two request shapes; "Provider facts"
(Claude's API and Bedrock answer JSON-schema questions).
**Track:** B, first. Worktree `../10db-worktrees/accounts-b`. Starts beside track A.

## Files

- `apps/daemon/src/judge/credential.ts`: `JudgeCredential` (below).
- `apps/daemon/src/judge/ask.ts`: `askModel` dispatches on `q.credential.kind`: OpenRouter to today's three
  endpoints (`openrouter.ts`, its `ModelApi` choice unchanged), Anthropic and Bedrock to the new files.
- `apps/daemon/src/judge/anthropic.ts`: one Messages call to `https://api.anthropic.com/v1/messages` with the key,
  the state and question as the user turn, the options and criteria as in `optionsText`, and structured output as a
  JSON schema `{ choice: enum(options), confidence: number }`. Verified by the coordinator from
  `platform.claude.com/docs/en/build-with-claude/structured-outputs` on 2026-11-21: the body carries
  `output_config: { format: { type: "json_schema", schema } }`, header `anthropic-version: 2026-10-21`; every object
  needs `additionalProperties: false` and every property in `required`; **numeric `minimum`/`maximum` are refused
  with a 400**, so clamp `confidence` to 0..1 in code, not in the schema; **enum casing is not guaranteed**, so
  match `choice` to the options case-insensitively; `stop_reason: "refusal"` or `"max_tokens"` is no answer
  (throw `JudgeCallError`). The answer is JSON in the first text block. zod-parse it; `confidence` is the answer's
  own. The same body works on Bedrock's runtime (the docs list Bedrock as supported).
  `costUsd` from `usage` and the account's listed price when the catalogue has it, else null.
- `apps/daemon/src/judge/bedrock.ts`: the same body through Bedrock's runtime `InvokeModel` (Anthropic's Bedrock
  body: `anthropic_version: "bedrock-2023-05-31"`), the model id from the account's list (already Bedrock ids),
  region from the account, signed with the account's AWS profile (`fromIni({ profile })`) or its bearer token from
  the Keychain. Check how the SDK takes a Bedrock bearer token (API key) in the version you pin and say so in your
  report.
- `apps/daemon/package.json`: `@aws-sdk/client-bedrock-runtime` and, if needed, `@aws-sdk/credential-providers`,
  each pinned exactly to its latest stable (`npm view <pkg> version`); `pnpm install` updates the lockfile.
- `apps/daemon/src/judge/judge.ts`: `JudgeDeps.readKey` becomes `readCredential`; nothing else in the judge's flow
  changes (timeout, fallback, `judge_calls` logging). The OpenRouter-only `decisionModelIds` is consulted only for
  an OpenRouter credential.
- `apps/daemon/src/daemon/judge-services.ts:88` (`createJudgeKeyReader`): becomes `createJudgeCredentialReader`,
  returning a credential for a live `openrouter`, `anthropic_api_key` or `bedrock` account (profile Bedrock needs
  no Keychain read), null otherwise. Card 6 changes the services' account checks; this card changes only the reader.
- `apps/daemon/src/daemon/start.ts:811-832`: `openRouterSync`'s `readKey` calls the judge's reader today. It must
  return a key **only for an OpenRouter credential** (`kind === AccountKind.OpenRouter`), else null: an Anthropic
  key or Bedrock token must never be sent to openrouter.ai. Card 6 adds the fallback to another OpenRouter account.
- `judge.ts:129` scrubs the key from logged text; scrub every secret in the credential (the Bedrock
  `bearerToken` too).
- Errors: a typed `JudgeCallError` (name, message naming the provider and HTTP status, never the key) replaces
  `OpenRouterError` at the dispatch boundary, or sits beside it.

## Interfaces (quoted from the index)

```ts
export type JudgeCredential =
  | { readonly kind: typeof AccountKind.OpenRouter; readonly key: string }
  | { readonly kind: typeof AccountKind.AnthropicApiKey; readonly key: string }
  | {
      readonly kind: typeof AccountKind.Bedrock;
      readonly region: string;
      readonly awsProfile: string | null;
      readonly bearerToken: string | null;
    };
readonly readCredential: (accountId: AccountId | null) => Promise<JudgeCredential | null>;
export function askModel(q: ModelQuestion): Promise<ModelAnswer>;
```

## Tests

- One test per new request shape, with `fetch` (Anthropic) and the Bedrock client's transport mocked at the network
  boundary: the body sent carries the schema with the options as its enum, and the answer parses into
  `{ choice, confidence, model, costUsd }`; a malformed answer throws `JudgeCallError` (core: these answer
  `crosses_limit`). Two tests in all.

## Done when

Typecheck, lint and related tests for daemon pass; `make precheck` passes. A live call is not required; if the
builder's Bedrock profile (`Orgtools Bedrock` account) is signed in, one live test decision is welcome and goes in
the report.
