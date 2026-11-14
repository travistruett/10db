import { BatchState, Delivery, PullRequestState, ShipReadiness } from '@10db/contracts';

// T4 call 13: where a follow-up of Run these now starts, read from the source as it stands when the
// follow-up starts, not when the button was pressed. A source whose pull request is still open is
// waited for: a second batch never ships on a branch another batch owns, so the follow-up starts
// from the base once the source has landed or its pull request was closed.

/** The source run's batch and pull request, as the follow-up's start reads them. */
export interface SourceState {
  /** The source run's batch; null for a run that has none. */
  readonly batch: BatchState | null;
  /** `shipReadiness` over the batch's members. */
  readonly readiness: ShipReadiness;
  readonly delivery: Delivery;
  /** The batch's pull request as last read; null when it has none. */
  readonly pullRequest: PullRequestState | null;
}

export type FollowUpStart =
  | { readonly kind: 'wait' }
  /** A new member of the source's open batch, in its worktree and on its branch. */
  | { readonly kind: 'join' }
  /** An ordinary start from the base, with what its description says when the source's work isn't on it. */
  | { readonly kind: 'base'; readonly note: string | null };

const NOT_ON_BASE = "so it isn't on the base this follow-up starts from.";

const base = (note: string | null = null): FollowUpStart => ({ kind: 'base', note });

export function followUpStart(source: SourceState): FollowUpStart {
  switch (source.batch) {
    case null:
    case BatchState.Closed:
      return base();
    case BatchState.Cutting:
    case BatchState.Shipping:
      return { kind: 'wait' };
    case BatchState.Open:
      return source.readiness === ShipReadiness.Blocked ? { kind: 'wait' } : { kind: 'join' };
    case BatchState.Abandoned:
      return base(`The source's work was abandoned, ${NOT_ON_BASE}`);
    case BatchState.Shipped:
      if (source.delivery === Delivery.Local) return base();
      return landed(source.pullRequest, base());
    case BatchState.Failed:
      return landed(source.pullRequest, base(`The source's work was never pushed, ${NOT_ON_BASE}`));
    default: {
      const unreachable: never = source.batch;
      return unreachable;
    }
  }
}

/** A shipped source by its pull request: merged starts from the base, open waits for it. */
function landed(pullRequest: PullRequestState | null, none: FollowUpStart): FollowUpStart {
  switch (pullRequest) {
    case null:
      return none;
    case PullRequestState.Merged:
      return base();
    case PullRequestState.Closed:
      return base(
        "The source's pull request was closed without merging, so its work isn't on the base this follow-up starts from.",
      );
    case PullRequestState.Open:
    case PullRequestState.Unknown:
      return { kind: 'wait' };
    default: {
      const unreachable: never = pullRequest;
      return unreachable;
    }
  }
}
