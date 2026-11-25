# Acceptance checks each criterion beside Review, and never waits on the builder

- **Date:** 2026-11-25
- **Spec:** `docs/superpowers/specs/2026-11-25-acceptance-checks-each-criterion-design.md`

## Decision

After a run's final gate passes, a judge reads the run's diff against each of the task's acceptance criteria:

- a cheap yes/no question per criterion (`acceptance`);
- a stronger model for any criterion the first didn't read as met (`acceptance_second`).

The verdicts lead to one of these:

- **Not met:** the run goes back to its implement step on the rigor's review rounds and fix rule, through a `fix`
  action that can resume its session.
- **Unclear, with a Review to follow:** the criteria go to the reviewer.
- **Not met at the limit, or unclear with no Review:** the run goes on, and one `acceptance` Inbox card lists the
  criteria. On the card, Accept marks them met, and Send back files a follow-up task.
- **No answer from the judge:** the run goes on as before.

Acceptance is a judge pass in `verify`, not a step role. Both decisions ship switched off. They are turned on as a
data change once a replay of past runs meets the spec's bar.

## Why

The builder chose to put it beside Review first, so its agreement with the reviewer can be measured before it
replaces Review anywhere. A run never waits on the card: a task that stops to wait on the builder is a bug, and a
reviewer at its round limit already ships and leaves its findings. A step role would add a Playbook row, and a model
and persona pick, for something that has no session.
