# Codex searches the web live, as Codex and Claude Code do

- **Date:** 2026-11-14
- **Supersedes:** the web-search line of `decisions/2026-11-12-codex-is-judged-by-10dbs-judge.md` (`cached` in
  every session, `live` never sent), the plan line "Web search stays `disabled`" of
  `decisions/2026-11-14-plan-and-sessions-run-on-codex-without-claude-only-subagents.md`, and call 12 and Task 13
  row 5 of `docs/superpowers/plans/2026-11-12-10db-trust-t5-tendb-judge-and-codex.md`

## Decision

A Codex thread gets `web_search = "live"` wherever a Claude session of the project searches the web, under the
same Web switch: a lane, a chat and a Plan thread send `live` with the switch on and `disabled` with it off.
`cached` and `indexed` are never sent. The account home keeps `disabled` as its default, and the thread's own
setting wins. There is no `allowed_domains` list, no check after a search and no card.
`capabilities.webSearch` is true for Codex, so a chat there says it searches the web while the switch is on. A
Codex lane's briefing tells it that its search runs on OpenAI's servers and to keep the project's code and secrets
out of a query or URL, and Settings › Trust says the same under the Web row.

Per provider: Claude on a plan, Bedrock or an API key keeps WebSearch and WebFetch through its hook and judge;
Codex on a ChatGPT plan searches live. Both follow the Web switch.

## Why

- Codex and Claude Code both search the web by default; 10db matches them rather than holding Codex back for a
  check the builder did not ask for.
- The cost, accepted by the builder: a Codex search runs on OpenAI's servers, so 10db's judge never sees a search
  or page URL before it is fetched, and a prompt-injected agent could put data in a URL. The queries already
  reach OpenAI, which holds the conversation.
- `cached` was chosen to avoid that cost, but the hand check recorded in the T5 plan (`codex exec` 0.167.0)
  showed Codex accepting an open-page action under `cached` too, so it never bought the property it was chosen
  for.

## Live check

`codex exec --json -s read-only -c 'web_search="live"'` (codex-cli 0.167.0, ChatGPT plan), asked with the built-in
search tool only for the top headline on the BBC News site: three `web_search` items with queries ran and the
agent answered with a headline dated the day of the check. This shows `live` searches on a ChatGPT plan; it was
not run through 10db's app-server thread, which sends the same `web_search` key in `thread/start`'s config.
