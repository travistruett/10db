# Factory is one live list of every project's runs, by what they need

- **Date:** 2026-11-19
- **Amends:** `docs/superpowers/specs/2026-10-29-10db-goals-design.md` §2 ("Factory: goals running") and §8

## Decision

Factory's page, under **Live**, is one list of every project's runs (narrowed by its Project filter), in
sections by what the builder would do about them: Needs You, Failed, Running, Queued, Done Today. A section
with nothing in it is left out, and with nothing going on the page says "Nothing is running" with Plan Work.

- Each task shows its latest run only, so a retried failure leaves Failed. Failed shows for a week and Done
  Today for 24 hours, both measured from the run's last activity, or its last change when it has none.
- A row reads: status dot, the task, what it is doing (its step, the failure, what it waits for), its
  project's tile and name, and how long ago. It opens the task on its project's Board. A failed row has
  Retry beside it.
- A live UI Workbench pass is a row under Needs You while pages wait on the builder, else under Running.
- Goals are a **Goals** section under the list, each project's goals under its name, opening their digest as
  before. With no goals anywhere there is no section and no text about goals. The Not in a goal row is gone:
  that work is the list.
- The header holds Live | Metrics, the Activity button, the Project filter and one Plan Work.
- **Metrics** holds the Rigor, Human touch and Card types panels for one chosen project
  (`/factory?view=metrics`).

## Why

The page was a section per project framed by goals. The builder uses few goals, so it showed the same
explanation of goals once per project, and the one running task sat folded in Not in a goal; an idle project
took as much room as a busy one. The question only Factory answers is what 10db is doing now, without the
builder, across projects, and whether anything is stuck. Grouping by what each run needs answers it at a
glance, and the project becomes a tag on the row instead of the page's frame. The analytics answer a different
question (how the factory has done over weeks), so they moved behind Metrics rather than going. Removing
Factory and spreading its parts over the rail and the Inbox was turned down: it would leave no single place to
watch unattended work. The more creative pass the builder wants is later.
