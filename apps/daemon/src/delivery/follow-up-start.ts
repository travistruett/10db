import { BatchState, Delivery, PullRequestState, ShipReadiness } from '@10db/contracts';

// Where a follow-up of Run these now starts, read from the source as it stands when the follow-up
// starts, not when the button was pressed. A source whose pull request is still open is waited for:
// a second batch never ships on a branch another batch owns, so the follow-up starts from the base
// once the source has landed or its pull request was closed. A pull request that can't be read
// blocks nothing: the follow-up starts from the base and says the source's work may not be on it.

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
  /** Not yet; `reason` is what the follow-up's task says while it waits, null when it says nothing. */
  | { readonly kind: 'wait'; readonly reason: string | null }
  /** A new member of the source's open batch, in its worktree and on its branch. */
  | { readonly kind: 'join' }
  /** An ordinary start from the base, with what its description says when the source's work isn't on it. */
  | { readonly kind: 'base'; readonly note: string | null };

const NOT_ON_BASE = "so it isn't on the base this follow-up starts from.";

const base = (note: string | null = null): FollowUpStart => ({ kind: 'base', note });
const WAIT: FollowUpStart = { kind: 'wait', reason: null };
const ON_PULL_REQUEST: FollowUpStart = {
  kind: 'wait',
  reason:
    "Waiting for the source's pull request to merge or close: a second batch never ships on a branch another batch owns.",
};

export function followUpStart(source: SourceState): FollowUpStart {
  switch (source.batch) {
    case null:
    case BatchState.Closed:
      return base();
    case BatchState.Cutting:
    case BatchState.Shipping:
      return WAIT;
    case BatchState.Open:
      return source.readiness === ShipReadiness.Blocked ? WAIT : { kind: 'join' };
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

/** A shipped source by its pull request: merged starts from the base, open waits for it, unread doesn't. */
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
      return ON_PULL_REQUEST;
    case PullRequestState.Unknown:
      return base(
        "10db couldn't read the source's pull request, so its work may not be on the base this follow-up starts from.",
      );
    default: {
      const unreachable: never = pullRequest;
      return unreachable;
    }
  }
}
