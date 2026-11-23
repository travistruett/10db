# Card 6: the migration

**Decision:** `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`, "A project names its workspace, or
none" (existing projects bound at upgrade) and "One person, a contact per workspace". `AGENTS.md`: "A branch
generates its migrations last"; `packages/db/AGENTS.md`: forward-only from `v0.1.0`, and "A column a rebuild
needs comes in an earlier migration".
**Track:** A, last: after every other card and the final merge of `main` into the integration branch. Before
starting, check that no other open pull request adds a migration (`gh pr list` and each PR's
`packages/db/drizzle` diff). If one does, wait for it to land and merge `main` again. **Core:** migrations.

## Files

- **Regenerate.**
  - Delete card 1's dev migration: its `.sql`, its snapshot in `drizzle/meta/` and its `_journal.json` entry.
  - Run `pnpm --filter @10db/db generate --name slack_workspaces`. Expect: drop
    `person_contacts_person_id_unique`, create `person_contacts_person_team` on `(person_id, team_id)`, and add
    `stakeholder_sends.team_id`. No table rebuild; if drizzle-kit writes one, stop and report.
- **The data migration.** `pnpm exec drizzle-kit generate --custom --name slack_workspaces_backfill` in
  `packages/db`, authored once by hand, after the generated one. Comment each statement with what and why.
  1. Each send's team from its first recipient's contact:
     `UPDATE stakeholder_sends SET team_id = (SELECT pc.team_id FROM stakeholder_send_people sp JOIN
     person_contacts pc ON pc.person_id = sp.person_id WHERE sp.send_id = stakeholder_sends.id AND
     sp.recipient = 1 ORDER BY sp.position LIMIT 1) WHERE team_id IS NULL`. Before this build a person had at
     most one contact, so this is that contact's team.
  2. A send whose recipients have no contact left takes the workspace signed in now:
     `UPDATE stakeholder_sends SET team_id = (SELECT json_extract(value, '$[0].teamId') FROM app_settings WHERE
     key = 'slack.workspaces') WHERE team_id IS NULL`. Before this build every writer kept at most one entry,
     so `$[0]` is that one. It is the only place in the branch that reads the first entry; say so in the
     comment. With none, the team stays null and the send counts for no workspace.
  3. Every project without a stored choice is bound to that workspace:
     `INSERT OR IGNORE INTO app_settings (key, value, updated_at) SELECT 'slack.' || p.id,
     json_object('teamId', json_extract(s.value, '$[0].teamId')), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM
     projects p JOIN app_settings s ON s.key = 'slack.workspaces' WHERE json_array_length(s.value) > 0`.
     `OR IGNORE` keeps a stored choice, Off (`{"teamId":null}`) included.
  - Check against `packages/db/src/schema.ts` that `app_settings.value` is JSON text and `updated_at` is ISO
    text, and match the format other rows use.
- **Docs.**
  - `docs/architecture/db-storage.md`: extend the stakeholder entry. `person_contacts` is one row per person and
    workspace; `stakeholder_sends.team_id` is the workspace a send was drafted in; `slack.<projectId>` with no row
    is Off; workspaces in `slack.workspaces` carry their bot. Name both migrations by their numbers.
  - `packages/db/AGENTS.md` only if a rule changed.

## Interfaces it implements

None new. It fills, for existing data, the columns and settings that card 1's schema and card 2's
`projectSlack` read:

```ts
export function projectSlack(db: DbReader, projectId: ProjectId): ProjectSlackDto;
// stakeholder_sends: teamId: text('team_id')
// person_contacts: uniqueIndex('person_contacts_person_team').on(t.personId, t.teamId)
```

## State-table rows

- upgrade, one workspace W → every project without a setting bound to W; a stored Off stays Off; each send gets
  its team; contacts keep their rows.
- upgrade, no workspace → nothing bound; every project reads Off.

## Tests

Core: a migration. One new file, `packages/db/src/migrations-slack-workspaces.test.ts`, on the pattern of
`migrations-model-ids.test.ts`: a real database file in a temp directory, migrated with `migrationsBefore` to the
migration before this one, seeded with SQL, then migrated the rest of the way.
- **One workspace.** Seed `slack.workspaces` with W; projects P1 (no setting) and P2 (`{"teamId":null}`); Mark
  with a W contact and a DM channel; two sent sends, one to Mark and one whose recipient's contact was deleted.
  After the migration:
  - the contact count and Mark's row are unchanged;
  - both sends have team W;
  - P1's setting is `{"teamId":"W"}` and P2's is still `null`;
  - Mark can be given a contact in a second team, and a second W contact is refused by the unique index.
- **No workspace.** The same seed without `slack.workspaces`: no `slack.` setting is written; the send to Mark
  has W from his contact; the other has none.

Prove it red first: drop statement 3, and the P1 assertion fails. Value card: `protects=an upgrade keeps
every project sending where it sent and every contact and send in its workspace; fails_when=the backfill misses
a send, drops a contact, or overwrites a project's Off; why_new=migration (core); no_claim=databases with more
than one workspace stored, which no earlier build could write`.

## Done when

The checks in Global Constraints pass and `pnpm --filter @10db/db drift` is clean. A daemon built from `main`, run
on a throwaway data directory with `TENDB_SLACK=off` and given one workspace entry and a project, then restarted
on this branch, reads that project bound to the workspace. Never use the real data directory.
