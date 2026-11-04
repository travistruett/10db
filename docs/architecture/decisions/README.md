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
cited file exists. What a decision chose is never edited after it merges: a changed choice or changed reasons
go in a later file that amends or supersedes it.

Two edits in place are allowed after a merge:

- Fixing a broken link.
- Correcting a statement of fact about the code, when the record names what the code does (a refused option, a
  limit, a path, a name) and the code now differs or the record misstated it. The correction makes the record
  match the code as merged; it does not change the choice or the reasons. Do it in the pull request that
  changes the code, or in one that fixes the record, and say in that pull request what was corrected. A fact
  that is the point of the decision (the choice itself) is not a fact to correct: that is an amendment.

When in doubt, write the amending file.

These are the design records of this repository. The decisions an agent records with `record_decision` while
10db runs a project live in that project's database (decision 6) and never come here.
