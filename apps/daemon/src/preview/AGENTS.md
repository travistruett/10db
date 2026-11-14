# apps/daemon/src/preview

- `preview/` (`decisions/2026-11-11-10db-runs-the-preview-while-a-pass-is-open.md`): `startPreview` runs a project's
  `previewCommand` while it has a live pass, through the unslotted gate runner (the gate's sandbox; no project id, so
  `autoDocker` never turns Docker on for it) with no timeout and an abort that kills its group; its tree goes in a
  process ledger (`preview-ledger.ts`), as the pictures browser's does, and a stop that waits past `stopWithinMs` for
  the command to exit ends that tree instead. It starts nothing when something answers at the app address already
  (`probe.ts`; any response, an https server with a certificate of its own included) or the project lacks Allow
  loopback (then a `preview_stopped` notice says so), restarts an exit while wanted at most 3 times in 10 minutes
  (`restart-budget.ts`), and keeps one header notice, `preview-server`: `preview_starting` until the app answers
  (looked at until it does, the deadline only changing the words), `preview_stopped` with the output's tail once it
  gave up, cleared once the builder's own server answers. A notice is cleared on the pass it was written on, so an
  ended pass keeps none. It follows `pass.opened`, `pass.changed` and `project.changed`; at start it clears the
  notice on every live pass and looks at each. A picture that finds nothing answering at a project with a preview
  command calls `onNoAnswer` (`lost`: starts the preview when none runs, says a running one that answered no longer
  does) instead of raising the "Nothing answers" notice. `POST /projects/:id/preview/restart` is Restart Preview.
  Shutdown stops it after the pictures.
