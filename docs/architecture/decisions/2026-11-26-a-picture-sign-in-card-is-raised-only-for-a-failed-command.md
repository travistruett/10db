# A picture's sign-in raises its card only when the dev login command fails

- **Date:** 2026-11-26
- **Amends:** `decisions/2026-11-25-the-daemon-uploads-a-tasks-pictures-to-linear-and-says-why-it-has-none.md`

## Decision

A sign-in taken for a picture raises the project's failed-sign-in card (`inbox/sign-in-card.ts`) only when the dev
login command itself fails (a non-zero exit, a timeout, no address printed). A browser that could not open the
address raises no card. Every failed sign-in still leaves the per-project record `Pictures.outlook` reads, so the
task's Linear and Slack updates say the pictures were skipped.

## Why

A browser that cannot open the printed address may only mean the app is down, which says nothing of the command;
a card asking the builder to fix the command would mislead. The record is cheap and stays truthful, so the
updates still explain a missing picture.
