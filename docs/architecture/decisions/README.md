# Decisions

One file per decision about 10db's own design, named `YYYY-MM-DD-<slug>.md`: the date it was decided and a
few words saying what. The numbered log in [`../decisions.md`](../decisions.md) is closed at 133; its rows
stay as they are and are still cited by number ("decision 129").

A decision file reads:

```markdown
# The decision in one line

- **Date:** 2026-10-27
- **Amends:** decision 133 (optional; also **Supersedes:**, naming a number or a file)

## Decision

What was decided, specific enough to check the code against.

## Why

The reasons, the evidence and the alternatives turned down.
```

Cite a decision by its path, `decisions/2026-10-27-one-file-per-decision.md`; a repo test checks that every
cited file exists. A decision is never edited after it merges, except to fix a broken link: a later file
amends or supersedes it.

These are the design records of this repository. The decisions an agent records with `record_decision` while
10db runs a project live in that project's database (decision 6) and never come here.
