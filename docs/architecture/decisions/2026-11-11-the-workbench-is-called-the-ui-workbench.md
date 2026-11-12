# The Workbench is called the UI Workbench

- **Date:** 2026-11-11

## Decision

Everything the builder reads names the view "UI Workbench": the sidebar, the view's title, buttons ("Open UI
Workbench"), the Board's and Inbox's lines ("Waiting on you in the UI Workbench"), and the daemon's cards and
refusals ("UI Workbench pass "Settings pass" closed"). Code, routes (`/workbench`), the database and the
design documents keep `workbench` and "Workbench"; nothing migrates.

## Why

The builder's call during the Workbench's QA. Every pass is about pages, and every later phase in the spec
(pictures in copies, live preview links, the capture button) still is. "Workbench" alone invites the question
of whether backend work belongs there; "UI Workbench" answers it in the sidebar.
