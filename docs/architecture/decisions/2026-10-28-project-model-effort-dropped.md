# A project no longer carries a model or an effort

- **Date:** 2026-10-28
- **Amends:** `decisions/2026-10-28-routing-role-defaults.md` (the follow-up it names)

## Decision

`ProjectInput`, `ProjectDto` and the `projects` table lose `model` and `effort`. The
migration `0006_drop_project_model_effort` drops both columns; the migration baseline is not regenerated
(`v0.1.0` is released). `PROTOCOL_VERSION` goes to 5, since a field leaves the API.

A new workstream starts with the model and effort of its plan's first step, and a workstream inserted with
no plan shows `sonnet` at medium effort until a plan sets them. Nothing reads either value from a project:
routing runs a step on its role's default when no score routes it.

## Why

The columns had no reader once routing took role defaults, and a setting nothing reads invites the
builder to change it and expect an effect. Leaving them in the schema until the next baseline was turned
down: after `v0.1.0` migrations only go forward, so the drop is one more migration.
