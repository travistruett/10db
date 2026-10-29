# Pull request delivery no longer requires a PR title prefix

- **Date:** 2026-10-28
- **Amends:** `decisions/2026-10-28-pr-title-from-the-work.md`

## Decision

A project with pull request delivery may leave its PR title prefix empty. `ProjectInput`, `patchProject` and
both desktop forms (new project, Settings > General) accept a null prefix, and the forms' help text says that
an empty prefix means the title is derived as `<type>(<scope>): <subject>`. A prefix, when given, still has
to be a Conventional Commit type with an optional scope and still replaces the derived type and scope.

## Why

The derived title was built but unreachable while saving a project demanded a prefix. This is the follow-up
that decision named. Showing the proposed title on the Start sheet remains open.
