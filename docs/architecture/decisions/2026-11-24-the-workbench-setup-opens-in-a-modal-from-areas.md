# The Workbench setup opens in a modal, from Settings › Areas and Hazards and the start page's Review line

- **Date:** 2026-11-24
- **Amends:** `2026-11-23-the-workbench-setup-is-reached-from-pages-and-pictures.md`

## Decision

Review Suggestions moves from Settings › App Preview to the Areas heading in Settings › Areas and Hazards,
shown only while the setup has suggestions. It and the start page's Review line open the setup in a modal
over the screen they are on; Cancel and Apply close it there. The setup is a full page only in a project with
no page area, where it is the Workbench itself. The `setup` search parameter on `/workbench` is gone.

## Why

The builder found Review Suggestions out of place in App Preview, and following it left Settings for a
full-page screen whose only way back, Back to Pages, landed in the Workbench. Most of what the setup
suggests is pages, which are areas, so Areas is where it reads as belonging. A modal keeps the builder where
they asked from.
