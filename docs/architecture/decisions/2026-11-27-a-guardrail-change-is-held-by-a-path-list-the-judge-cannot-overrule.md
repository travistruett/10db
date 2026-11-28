# A guardrail change is held by a path list the judge cannot overrule

- **Date:** 2026-11-27

Status: designed, not built. The plan is `docs/superpowers/plans/2026-11-27-guardrail-changes-reach-the-builder.md`.

## Decision

- The guardrails are one pure table of paths, `GUARDRAIL_PATHS` in `apps/daemon/src/guardrails/paths.ts`: the git
  guard (`.claude/hooks`), Codex rules (`.codex/rules`), `.claude/settings.json`, `.claude/settings.local.json`,
  `.codex/config.toml`, `.10db/mcp-hosts.json`, `.mcp.json`, hooks (`.git/hooks`, lefthook's files, the rest of
  `.claude` and `.codex`) and CI (`.github/workflows`, `.github/rulesets`). A file has one kind, the first row it
  matches.
- A pull request whose diff against its base touches one of them is held: 10db never turns on auto-merge for it
  and never merges it. One builder card shows the diff with Merge and Close. Merge approves that exact diff, by
  its hash; a later push with a different guardrail diff holds again.
- The hold is decided from the path list alone. No judge answer, watchpoint reading or agent's claim is an input,
  so none can lift it.
- The hold belongs to the pull request. It is read over the whole pull request (the merge base with the base
  branch to the head), and stored under the root batch, so a CI-fix batch, a catch-up or a merge retry reads the
  same hold.
- A pull request whose diff can't be read is held.
- Auto-merge is turned off before any push to a held pull request, and a failed turn-off stops the push.
- `AGENTS.md` and `CLAUDE.md`, `.env` files and git's internals (`.git/config`, `.git/info`) are not in the list.
  A stray write to one still raises today's card; a pull request that changes one is not held.
- Judge policy, trust grants and standing approvals are rows in 10db's database. The list's rows of those names
  cover the checkout files that grant the same things.
- A Workbench pass's pull request and a landing into a local copy are not held by this.

## Why

- The spec (`docs/superpowers/specs/2026-11-27-what-reaches-the-builder-design.md`, §1 row 3 and §2) makes the
  guardrails the builder's because the contained can't hold its own keys, and says a deterministic yes can't be
  overruled by the judge. A judge that reads a diff as harmless is reading text an agent wrote.
- Per-batch hits were turned down in plan review: a CI-fix batch is cut from the pull request's head, so its own
  range shows no guardrail change and it would arm auto-merge on a held pull request.
- Approval by hash rather than a flag: a flag would let a second guardrail change ride the first approval.
- Agent instructions are left out because most pull requests change one, and holding them all would make the card
  mean nothing; the Agent instructions watchpoint already puts them in front of the builder. Spec §1 row 3 does
  not name them.
- The database rows are not in a checkout, so no pull request carries them, and the daemon is their only writer.
- A pass's pull request is never merged by 10db, so it already waits for the builder; its card is a follow-up.
