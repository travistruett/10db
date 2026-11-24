import { BatchFailure } from '@10db/contracts';

/** Why a batch was not shipped, in plain words. */
export const FAILURE_LABELS: Readonly<Record<BatchFailure, string>> = {
  [BatchFailure.WrongBranch]: 'The checkout is not on the batch branch',
  [BatchFailure.DirtyCheckout]: 'The checkout has uncommitted changes',
  [BatchFailure.GateFailed]: 'The gate failed',
  [BatchFailure.GateTimedOut]: 'The gate timed out',
  [BatchFailure.BaseConflict]: 'The base branch conflicts with the batch',
  [BatchFailure.InstallBroken]: "The install in the batch's copy is broken",
  [BatchFailure.PushRejected]: 'git push was rejected',
  [BatchFailure.GhUnavailable]: 'gh is missing or signed out',
  [BatchFailure.Network]: 'A network step failed',
  [BatchFailure.InterruptedLanding]:
    'A landing in your folder was interrupted; check the folder before retrying',
  [BatchFailure.LockfileInCopy]: "The copy's work changed a lockfile, which a copy does not land",
  [BatchFailure.GateChangedCopy]:
    'The gate changed the copy while it ran, so its pass counts for nothing',
  [BatchFailure.GitFilters]: "Your folder's git filters would rewrite what the landing writes",
};
