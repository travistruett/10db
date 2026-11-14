# Plan and Sessions run on Codex, without Plan's Claude-only subagents

- **Date:** 2026-11-14
- **Amends:** `decisions/2026-11-05-chatgpt-plan-through-the-codex-app-server.md`

## Decision

- **A conversation runs on a ChatGPT plan.** The out-of-scope line of the amended decision, "brainstorm chat on a
  ChatGPT account (refused with an error that says so)", no longer holds. Plan and a Sessions chat start, take
  messages, change model and Propose on a project whose account is a ChatGPT plan, as on a Claude one. Every refusal
  site goes: `BRAINSTORM_REFUSED_ON_CHATGPT` and `CHATS_UNAVAILABLE_ON_CHATGPT`, `ShapeServiceDeps.brainstormRefusal`,
  the chat service's `unavailable` and `ChatModelsDto.unavailable`, the Codex adapter's explore stub, and the desktop's
  ChatGPT title and Sessions line.
- **On Codex a conversation is the attended explore profile** (sessions spec §5.5, trust line §4, §5). The adapter
  opens the same `startCodexSession` a lane does: the checkout pinned `untrusted`, Plan's read-only lane sandbox as the
  thread's `lane` permission profile, `approvalPolicy: 'never'`, and the guard hook sending each call to the
  conversation's judge (10db's judge, or the `rules` floor where it has none). A call 10db's judge asks about reaches
  the broker as a card. The builder's skills go through `skills/extraRoots/set`; the conversation's own prompt, then
  the project's and the builder's instructions, go in `developerInstructions`. 10db's MCP server has
  `tool_timeout_sec` raised to the conversation's tool wait.
- **Web search stays `disabled`** on every Codex conversation until a live check shows `cached` fetches no page the
  agent names.
- **Plan on Codex runs without its research and review agents** (sessions spec S8). Codex has no Agent tool, so
  `capabilities.subagents` is false: Plan's session gets no `agents`, its prompt names none and says what waits on a
  Claude account, and Plan's header says "Research and review agents need a Claude account. This conversation runs
  without them." A follow-up task, "Plan's researchers and reviewers on Codex", closes the gap by running those roles
  as their own Codex threads.

## Why

Provider parity (`AGENTS.md`): a project's account is its billing line, and a project on a ChatGPT plan could not
plan its work or chat at all. The attended profile already exists for Codex lanes: the read-only sandbox, the hook
and 10db's judge (`decisions/2026-11-05-codex-lanes-use-codex-sandbox-and-hooks.md`,
`decisions/2026-11-12-codex-is-judged-by-10dbs-judge.md`), so a conversation reuses that session rather than a second
Codex loop. The subagents are Claude Code's own `agents` option; Codex has none to hand them to, and saying so in the
header is what parity asks for where a provider lacks a part. Turned down: keeping the refusal until the subagents
run on Codex, which leaves a ChatGPT project with no Plan for the length of that work.
