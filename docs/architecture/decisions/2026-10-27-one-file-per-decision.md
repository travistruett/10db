# Each new decision is its own file, named by date and slug

- **Date:** 2026-10-27
- **Amends:** the numbering rule of the decision log in `docs/architecture/decisions.md`

## Decision

The numbered decision log closes at decision 133. Its rows keep their numbers and are still cited as
"decision N". A new decision about 10db's design is a file in `docs/architecture/decisions/` named
`YYYY-MM-DD-<slug>.md`, with a title, its date, a Decision section and a Why section, and is cited by its path.
`tests/repo/src/architecture-docs.test.ts` checks the closed log, each file's name and sections, and that
every cited file exists.

## Why

Every parallel branch appended to the same table and took the same next number, so each merge needed a
renumber and a fix to every citation. With 10db building itself in several lanes, that becomes a conflict on
every PR. A file per decision has no shared counter and no shared lines: two branches can't collide unless they
choose the same date and slug, which git reports as an ordinary conflict.

Turned down:

- Relaxing the check to unique and increasing numbers still lets two branches take the same next number,
  and both still edit the last lines of one file.
- Moving these records into 10db's database: they are the design record of a public repository, reviewed in
  pull requests and read by contributors and agents that don't run 10db. The database holds the decisions
  agents make while 10db runs a project (decision 6), and it is local to one machine.
- Renumbering the 133 rows into files: 186 citations across 28 files would change, for no gain.
