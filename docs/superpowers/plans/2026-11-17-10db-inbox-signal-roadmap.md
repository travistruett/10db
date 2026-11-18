# Inbox signal: roadmap

## Brief

**What changes for you.** The Inbox counts and notifies only what needs you. This happens in four milestones, plus
an optional fifth.

- **S1** moves the notices out of the Inbox.
- **S2** turns overload and the other live conditions into a status line, and makes condition cards close
  themselves.

Together, S1 and S2 take last week's 73 flags down to about 6 counted. S4 takes the rest.

**What it buys.** A badge you can trust. The 325 Dismiss-only flags since 2026-10-28 stop arriving, and a test
stops new ones.

**What could go wrong, and how we'd know.** The risks are in the spec's brief
(`docs/superpowers/specs/2026-11-17-10db-inbox-signal-design.md`). The one specific to sequencing: S1 and S2 change
the count Inbox M3 builds (`openRowsPage`). Nothing here starts until `feat/sessions-and-inbox` is on main.

**Needed from you:** mark each milestone in the cut table. The defaults below are my recommendation.

**For agentic workers:** this is the index. A milestone gets a plan file only once its predecessor has merged. Each
plan stays under about 8,000 words. Coordinate the build with the `coordinating-builds` skill. No milestone adds a
migration. If a plan finds it needs one, it tells the Sessions orchestrator before adding it: only one open PR may
add migrations at a time.

## Builder's cut

| # | Milestone | Needed for the goal? | Needs | Migration |
| --- | --- | --- | --- | --- |
| S1 | Tiers and notices: required `tier`, `urgency` and `closesWhen` on `FlagInput` and the delivery `Card`; the sort table applied; `notice.posted` and the Activity list | **needed** | `feat/sessions-and-inbox` on main | none |
| S2 | Status and closers: `GET /status` with hysteresis in the daemon and the header line; overload, model-list wait and update hold leave the Inbox; the new `CardResolvesWhen` events; Try Again on a failed update; condition cards update in place and offer no Dismiss | **needed** | S1 | none |
| S4 | `.git` stray writes at the source: hooks run a builder-owned lefthook, never one in a checkout's `node_modules`; Trust This Version, checked again at answer time; the checksum file and git's config bookkeeping excused | **needed** | S1; can run beside S2 | none (app setting) |
| S3 | Enforced: the repo test that every card builder and `flag(` site is in the sort table, and that no Dismiss-only ask lacks a closer | **needed** | S2 and S4 | none |
| S5 | The judge: `answer_from_knowledge` and `ask_urgency`, shadow first | later | S3 | none |

**S4 follows S1,** because both change the watcher's `flag(` calls.

**S4's hooks part runs ahead as its own task** (`tsk_01a1ed31-b681-76ca-9d4d-2c26012c83ef`), because it closes a live
path out of the sandbox and touches no Inbox code. S4 keeps Trust This Version and the config and checksum
excusals.

**S3 runs last of the four.** Until S4 gives stray-write cards Trust This Version, they are Dismiss-only with no
closer on sensitive paths, and S3's test would flag them. No milestone ever stops a card from being raised.

## Milestones

### S1: Tiers and notices

- `FlagInput` and `Card` (`delivery/cards.ts`) take a required `tier`, `urgency` and `closesWhen`. The spec's §4.4,
  §4.5 and §5 give the value for each existing builder. The shared open-when-busy notify callback takes a tier from
  each caller.
- `openRowsPage` is unchanged. A notice is never stored as an Inbox card, so every stored flag is an ask. The tier
  is declared on the builder, not stored.
- **Notices.**
  - Notice-tier cards are posted as `notice.posted` events.
  - Batch notices stay on `batches.notices`.
  - A notice with a task shows in that task's drawer.
- **The Activity list.**
  - A daemon read: `GET /activity/page`, keyset by event `seq`, filtered by project.
  - The fourth switch item in the Inbox panel. It is not counted.
- Open cards of a type that is now a notice are withdrawn once at daemon start.
- **Decision file:** `docs/architecture/decisions/./2026-11-xx-every-card-has-a-tier.md`.
- **Tests:**
  - A pure table of card type to tier and urgency.
  - Real SQLite for `notice.posted` paging and for `openRowsPage`'s count.
  - `renderWithDaemon` for the Activity list.
  - One e2e: a deleted empty branch shows in Activity, and Open's count doesn't move.

### S2: Status and closers

- **The status read.**
  - `GET /status` with a `StatusDto`, and a `status.changed` event.
  - It covers the admission holds with their busiest processes, the update hold and the model-list waits.
  - Hysteresis is in the daemon, on the injected clock, per the spec's §4.3 state table.
- **The header line** is drawn beside today's download line. It has a details popover.
- `load/monitor.ts`, `model-list-wait.ts` and the update hold stop raising cards.
- **Closers.**
  - `update_installed`, `branch_ready` and `mcp_config_changed`, each wired at its success path.
  - Try Again on a failed update, per the spec's §6 table.
- **Condition cards:** they are raised with `refresh` and the Inbox offers them no Dismiss.
- **Tests:**
  - Pure: a clock-driven table for the status states.
  - Real git: `branch_ready`.
  - Real SQLite: the other closers, plus a condition card raised twice, which shows one updated card with no Dismiss.
  - `renderWithDaemon`: the header line.
  - One e2e against the real daemon: an injected overload shows the line and raises no card.

### S4: `.git` stray writes at the source

- The three parts are in spec §7.
- Hooks are installed from a builder-owned lefthook, so they name no checkout path and are byte-identical whichever
  checkout installed them.
- Each stray-write card gains Trust This Version. It trusts only when the file still matches the stamp the card
  shows.
- Every test is rung 4, in real git repos with maintenance off:
  - hooks installed from two worktrees are byte-identical;
  - a hand-edited hook must raise a card;
  - a hook rewritten while its card is open must not be trusted by the old card;
  - a real `git worktree add -b` and `push -u`;
  - a real `git config core.hooksPath`, which must raise a card.

### S3: Enforced

- A `tests/repo` test reads every card builder in `delivery/cards.ts` and every `flag(` call site. It fails on one
  the sort table doesn't name, and on a Dismiss-only ask with no closer.
- The rule goes in `apps/daemon/src/inbox/AGENTS.md`.
- No runtime check: a breach never drops a card.

### S5: The judge (later)

Spec §8. The plan is written only if you move it to needed. It absorbs `tsk_01a1a464`.

## Filed separately (not in this roadmap)

- Reduce the Mac's load: worktree sweep and Spotlight exclusion (`tsk_01a1ed31-b803-7029-9a68-b250e4d5f54d`).
- Per-type noise report on the Factory page (`tsk_01a1ed31-b969-7799-a014-a3e5c33c2a11`).
