# Task 2: a stray write onto a guardrail is a card with the diff, Keep and Revert

Read the index's Brief and Global Constraints first. Size: Core (the watcher; Revert removes a file). Starts after
task 1 has merged.

**Files:**

- `apps/daemon/src/watcher/watcher.ts`: the single stray card (`single`, inside the stray pass) for a guardrail
  path.
- New `apps/daemon/src/watcher/kept-copy.ts`: `keepCopy`.
- New `apps/daemon/src/inbox/guardrail-card.ts`: the detail key, the choices, the stray card's fields and its
  answer.
- `apps/daemon/src/inbox/trusted-writes.ts`, `apps/daemon/src/inbox/service.ts`: Keep and Revert on the answer.
- `apps/desktop/src/views/inbox/`: a diff block for a card whose detail holds `GUARDRAIL_DIFF_DETAIL`.
- `apps/daemon/src/watcher/watcher.test.ts`, `apps/desktop/e2e/inbox.spec.ts`: extended.
- `apps/daemon/src/watcher/AGENTS.md`, `apps/daemon/src/inbox/AGENTS.md`: as built.

**Implements** (index, Interfaces): `GUARDRAIL_DIFF_DETAIL`, `GuardrailStrayChoice`, `keepCopy`.
**Calls:** `guardrailOf`, `applyTrustChoice`.

**The card.** In `single`, when `guardrailOf(rel)` is not null and the file has a stamp:

- title "A lane edited your `<label>`"; the body keeps today's lines (the path, who was working, the note);
- `decidedByBuilder(BuilderOwns.Guardrails)`, the same fold key (`strayFoldKey`), `closesWhen: BY_ANSWER`;
- `detail[GUARDRAIL_DIFF_DETAIL]`: the file's diff against `HEAD`, or its whole text marked as new when untracked,
  cut to a cap the module exports, with a flag saying it was cut. A file that can't be read as text says so
  instead of a diff;
- options Keep ("Stop flagging this exact content at this path") and Revert ("Put back the committed file", or
  for an untracked file "Remove it; a copy is kept").

A path `guardrailOf` answers null for (call 1's paths), a bulk card and a file with no stamp keep today's card and
choices.

**Keep.** `applyTrustChoice` accepts `GuardrailStrayChoice.Keep` beside its two choices and does what Keep It does:
the stamp is trusted in the answer's transaction, and a file that changed since raises the card afresh.

**Revert.** Runs after the answer's write, as a job, never inside the transaction:

1. Stamp the file again. If it no longer holds the card's stamp, do nothing and raise the card afresh, as Keep
   does for a changed file.
2. Tracked: restore the one path from `HEAD` through the git module (add the call there if none restores a single
   path). The checkout is the card's `root`.
3. Untracked: read its bytes, `keepCopy(home, projectId, rel, bytes, now)`, read the copy back and compare it byte
   for byte, and only then remove the file. A copy that does not match leaves the file and raises a failure
   notice.
4. The card's answer text names what was done, and for an untracked file the kept path.

A revert that fails (the path is now a directory, git refuses) leaves the file, and the card comes back with the
reason.

**`keepCopy`.** Creates `<home>/.10db/kept/<projectId>/<UTC stamp>-<sha12>/<rel>`, where the stamp is
`YYYYMMDDTHHMMSSZ` and `sha12` is the first 12 hex characters of the bytes' sha256. Directories are 0700 and the
file 0600. Nothing makes `~/.10db/kept/` today (`refs/10db/kept/` is a git ref namespace, not this folder); spec
stage 6 reuses this helper. `home` is injected with the daemon's home as its production default. `rel` is
rejected when it is absolute or holds a `..` segment.

**Desktop.** The Inbox card shows the diff in a scrolling monospace block under the body, with "Diff cut at N
lines" when the flag is set. Reuse the block `watchpoint-card.tsx` uses for hunks if it fits. No new component
test.

**Provider parity.** Identical on every account kind; nothing here asks a model.

**State-table rows:** the stray table of the index.

**Tests (extend, do not add a file).**

- `watcher.test.ts`, on its real temp repo: rewrite the guardrail half of "tells a write outside every claim to an
  ordinary path once as a notice ... but cards a guardrail path" so the guardrail path is `.github/workflows/x.yml`
  and the card has the new title, a diff in its detail, Keep and Revert. Add to it: Revert of a tracked file
  leaves `HEAD`'s content; Revert of an untracked one leaves no file and a kept copy with the same bytes under the
  injected home. `AGENTS.md` still raises today's card.
- `e2e/inbox.spec.ts`: one step in the existing stray flow: the card shows the diff and Revert restores the file.

Show the watcher test red before the card changes.

`Value: protects=a stray write onto a guardrail path is a builder card with its diff, and Revert puts the
committed file back or keeps a copy before removing an untracked one; fails_when=the write becomes a notice, the
card loses its diff, or Revert deletes an untracked file without a verified copy; why_new=permissions and data
loss (the watcher's guardrail card, a removal); no_claim=the held pull request, or paths outside the list`.

**Spec:** "3. The decision-rights table", row "Write outside every claim"; "2. Who decides", "A builder card's
guarantees".
