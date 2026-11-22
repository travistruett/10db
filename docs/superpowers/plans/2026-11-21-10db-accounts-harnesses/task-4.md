# Card 4: OpenRouter as a project's account

**Spec:** "OpenRouter runs projects on Codex": Models, Spend and cap, Removed, Judge; "Per job on an OpenRouter
account"; "Data" (the `openrouter-api-key` item and its move). **Spike:** "A small change" (the metadata warning
and the 402) and "Web search".
**Track:** A, after card 3, same worktree.

## Files

- **Models:** `apps/daemon/src/accounts/list-refresh.ts:63`: an OpenRouter account's list comes from OpenRouter's
  models API (`GET https://openrouter.ai/api/v1/models`, the key as bearer), keeping models whose
  `supported_parameters` include `tools`, each with OpenRouter's listed price; zod at the boundary. Tiers resolve as
  for any account with a list, with tier overrides (`tier-overrides.tsx` offers the list). Reuse the client in
  `apps/daemon/src/benchmarks/openrouter-client.ts` if it already reads the models API.
- **Settings:** `OpenRouterSettings` gains `...modelChoice` (tier overrides), and the OpenRouter `AccountInput`
  branch takes `settings: OpenRouterSettings.default({})`.
- **Spend and cap:** `contracts/accounts.ts`: OpenRouter is metered (`METERED`) and its `AccountInput` branch takes
  `laneCap` and `monthlyCapUsd` like other keyed kinds; `store/accounts.ts:122-136`, `:165` accept them. Spend is
  session cost plus `judge_calls` cost (`packages/db/src/store/usage.ts:43-74`); a cap pause stops new sessions and
  moves projects to their backup and does not stop Decisions.
- **Removed:** `refuseOpenRouterForAgents`, the launch refusal (`launch.ts:313-321`, if card 1 left any),
  `list-refresh.ts:63`'s skip, the comment saying OpenRouter never runs agents, and Billing's OpenRouter-specific
  disabled rows and copy (`views/settings/accounts/used-by.ts`, `project-setup.tsx:172`). The Accounts section and
  add-account modal describe OpenRouter as "Runs Codex; can power Decisions".
- **The old key item:** delete `apps/daemon/src/accounts/openrouter-key-move.ts` and its call; at startup the
  `openrouter-api-key` Keychain item, if present, is removed and nothing else happens. `OPENROUTER_KEY_ACCOUNT`
  stays only for that removal.
- **Codex adapter:** an `error` item whose message starts "Model metadata for" is a warning, logged once per
  session, not a failed turn. A turn failing with OpenRouter's 402 ends the turn with its text and pauses the
  account as other spend refusals do (find the existing refusal-pause path; don't add a new pause reason).
- **Web:** on an OpenRouter project the Web switch's description says "On OpenRouter, web search is live and
  doesn't show in the transcript." (spike: no `web_search` item; `cached` searches live).
- **Pictures:** `conversation/picture-limits.ts`: an OpenRouter account sends pictures when the model's listing has
  `image` in its input modalities, else says pictures aren't read on this model.
- **MCP:** Linear and other servers on an OpenRouter account are entries in its `CODEX_HOME`, as for a ChatGPT
  plan; `accounts/mcp-sign-ins.ts` lists Codex-harness accounts (card 1 moved it to the harness; check OpenRouter
  shows).
- **10db's errands** on an OpenRouter project run Codex on the Efficient tier model (follows from card 1 and the
  model list; confirm).
- Part 2's decision record, `2026-11-21-openrouter-runs-agents-on-codex.md` in `docs/architecture/decisions/`,
  **Supersedes** the refusal in `decisions/2026-10-31-openrouter-makes-routine-decisions.md`; cite spike 18.
  Update `apps/daemon/src/accounts/AGENTS.md` and docs that say OpenRouter can't run agents.

## State-table rows

- daemon starting / the `openrouter-api-key` item exists → removed.
- OpenRouter session running / "Model metadata ... not found" → a warning.
- OpenRouter session running / a 402 → the turn fails with the text; the account pauses.
- account over its monthly cap / a decision is asked → the decision runs; sessions stop and move.

## Tests

- Extend `apps/desktop/e2e/loop.spec.ts`'s Settings › Accounts step (near `:321-334`), on the fake adapter: add an
  OpenRouter account with a key, its row says "Runs Codex", and a project's Billing picker can select it. This is
  the user-visible check `testing.md` asks for; no rendered-component tests.
- Before you report, click through the same against the real daemon and save screenshots to your scratch folder.
- One test of the model list's filter and price parse from a recorded models-API body (parser, core rule).
- Update the tests of the deleted move and of the removed refusals; add no others. The cap rule is existing
  behaviour applied to one more kind; no new test.

## Done when

`grep -rn "CANT_RUN_AGENTS\|refuseOpenRouterForAgents\|moveOpenRouterKey\|can't run agents" apps packages docs/architecture`
finds only history; checks as card 1. Record in your report what a hand run would need (credit) so the
coordinator's QA list has it.
