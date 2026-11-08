# A model marked unusable from an error's wording ends on its own; one later session settles it

- **Date:** 2026-11-08
- **Amends:** `decisions/2026-11-07-models-come-from-a-catalogue.md` (a model that refuses at launch stays unusable until the account's list changes)

## Decision

A refusal of a model on an account rests on one of two bases (`ModelMarkBasis`, `packages/contracts/src/catalogue.ts`).

- **`error`**: Claude Code's own `model_not_found`. The mark is final: it lasts until the account's list changes
  the offer (launch ID or efforts), as before.
- **`wording`**: an `invalid_request` or `unknown` error whose text names the launch ID as a whole token with a
  missing, no-access, "not supported" or "not available" phrase (`modelRefusalBasis`,
  `apps/daemon/src/sessions/account-check.ts`). The mark ends by itself after `WORDING_MARK_MS` (one hour) and
  `account_models.wording_mark_ends_at` holds the time. While it holds the model is unusable as for any mark. When it
  ends (`endWordingMarks`, run by a clock timer set at the mark and by `resumeModelMarks` at daemon start) the model is
  routed to again, and the mark stays on record. One later session settles it:
  - a turn of that session ends well: the mark is cleared (`clearWordingMark`);
  - the session is refused again by wording: the mark becomes final (`confirmed`), like an `error` mark;
  - a refusal while the mark still holds (another lane) changes nothing; a `model_not_found` at any time makes it final.

A refreshed list that keeps the offer keeps the mark and its end; a changed offer drops both. The model drawer says for each
account whether the model was refused (final), or marked from an error's wording and when that mark ends or ended.
Shape's Plan conversations and the lanes share this rule (`markModelUnusable` in `apps/daemon/src/catalogue/model-marks.ts`).
The Codex adapter's refusals carry no basis and stay final: its phrases ("does not exist", "unknown model") are not the
ambiguous ones.

## Why

The wording of an error cannot tell a config error that names the model first ("Tool use with model X is not supported",
"Prompt caching for this model is not supported (X)", "Model X is not supported for batch requests") from a real
refusal ("Model X is not available in this region"). Three rewrites of the wording rule each let real refusals through
or broke the shape Claude Code sends (`API Error: 400 …`). A final mark on such a guess shuts a working model off until
the list changes; a mark that ends costs one failed session when it was right and one when it was wrong.

Turned down: a stricter wording rule (shown not to work); never marking from wording (a real regional refusal would
fail every step that reaches the model); a mark that stays until the builder clears it (a wrong guess would need a
person); counting steps instead of time (the drawer needs a time to show, and a clock timer needs no per-step
bookkeeping). The one hour is a judgement: long enough that a real refusal does not fail a session per task, short
enough that a config error does not outlast a working day.
