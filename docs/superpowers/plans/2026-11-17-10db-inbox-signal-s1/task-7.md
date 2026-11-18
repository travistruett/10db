# Task 7: docs — the decision and the module notes

**Spec:** the roadmap's S1 "Decision file"; AGENTS.md "Docs are part of done". **Part:** A. **Consumes:** Tasks 1-6.

## Files

- Create `docs/architecture/decisions/2026-11-17-every-card-has-a-tier.md`, in the README's format.
  - **Decision:**
    - every card has a tier (ask, notice, status), an urgency and a `closesWhen`, declared where it is built and
      required by the types;
    - a notice is a `notice.posted` event (or a batch notice), never an `inbox_items` row;
    - Activity reads the event log;
    - flags have no default urgency;
    - the three forms of `closesWhen`;
    - a `{ by: 'withdrawn' }` card keeps Dismiss, as a `{ by: 'answer' }` card does. S2's no-Dismiss rule applies
      only to cards whose `closesWhen` is a `CardResolvesWhen` condition (`{ by: 'event' }`).
  - **Why:**
    - the spec's §1 numbers;
    - the four mechanisms;
    - approach B over A and C;
    - why `withdrawn` is a third form;
    - why task notices sit on the `task` entity.
  - **Amends:** `decisions/2026-10-31-notices-not-cards.md`. A notice now has a home outside a batch.
- Modify `apps/daemon/src/inbox/AGENTS.md`. Add a section on tiers:
  - `CardTier`, `FlagInput`'s three required fields;
  - `postNotice` and its entity rule;
  - `GET /activity/page` and its grouping;
  - the start sweep;
  - "a new card builder declares its tier, urgency and `closesWhen`; a notice is posted, never flagged".
- Modify `apps/daemon/src/delivery/AGENTS.md`: `Card`'s required fields, `forTasks` sets them for refusals,
  `shipCard`, and `post`/`postIn` for delivery notices.
- Modify `apps/daemon/src/pass/AGENTS.md`: the follow-on notice marks a carry-over done (`hasNoticeKey`), and the
  gate-failed, folder-stays and abandoned-without-Move notices.
- Modify `apps/daemon/src/mcp/AGENTS.md`: `resize_task` posts a notice. Task 4 may have done this already.
- Modify `packages/db/AGENTS.md`: `pageActivity` reads `events` by `events_entity_idx` and by rowid. Add the eight
  medians from Task 2's commit, and the 50 ms line past which an index (a migration) would be needed.

## Steps

1. Write the files. Cite every decision by path. `tests/repo` checks that every cited file exists.
2. Run `pnpm --filter @10db/repo exec vitest run` on the docs tests: the decision links and the AGENTS/CLAUDE
   check. The package and test names are in `tests/repo/package.json`.
3. Format with `/Users/travistruett/Projects/10db/node_modules/.bin/prettier --write <files>`, from the main
   checkout's prettier.
4. Commit, naming every path: `docs: every card has a tier, and notices live in activity`. It needs no value card,
   since no behaviour changes.
