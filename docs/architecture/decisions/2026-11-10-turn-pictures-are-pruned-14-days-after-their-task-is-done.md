# Turn pictures are pruned 14 days after their task is done

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md`

## Decision

A turn picture is pruned once its task has been done or cancelled for 14 days (`TURN_PICTURES_KEPT_MS`); the
task's last update is read as when it was done. A before and an after are never pruned. No turn picture is
exempt yet, since no thread message can show one. The sweep (`pictures/prune.ts`) runs at daemon start and
every 24 hours: it sets `task_screens.pruned_at` (the row stays as a record) and deletes each file no unpruned
row names, so a file another kept row shares stays on disk.

## Why

Workbench spec §10 "When", plan call 24. Turn pictures are the bulk (one a turn per route and window) and
matter while a page is worked on; before and after are the record of what a task changed. A task's last update
can come later than its finish (a move between columns), which only keeps its pictures longer.
