import { BatchFailure, BatchState } from '@10db/contracts';
import type { MantineColor } from '@mantine/core';

const B = BatchState;

/** DESIGN.md status colors: blue in progress, red failed, green shipped, gray idle or over. */
export const BATCH_COLORS: Readonly<Record<BatchState, MantineColor>> = {
  [B.Cutting]: 'blue',
  [B.Open]: 'blue',
  [B.Shipping]: 'blue',
  [B.Shipped]: 'green',
  [B.Closed]: 'gray',
  [B.Failed]: 'red',
  [B.Abandoned]: 'gray',
};

export const BATCH_LABELS: Readonly<Record<BatchState, string>> = {
  [B.Cutting]: 'Cutting branch',
  [B.Open]: 'Open',
  [B.Shipping]: 'Shipping',
  [B.Shipped]: 'Shipped',
  [B.Closed]: 'Closed: no changes',
  [B.Failed]: 'Not shipped',
  [B.Abandoned]: 'Abandoned',
};

/** Why a batch was not shipped, in plain words. */
export const FAILURE_LABELS: Readonly<Record<BatchFailure, string>> = {
  [BatchFailure.WrongBranch]: 'The checkout is not on the batch branch',
  [BatchFailure.DirtyCheckout]: 'The checkout has uncommitted changes',
  [BatchFailure.GateFailed]: 'The gate failed',
  [BatchFailure.GateTimedOut]: 'The gate timed out',
  [BatchFailure.PushRejected]: 'git push was rejected',
  [BatchFailure.GhUnavailable]: 'gh is missing or signed out',
  [BatchFailure.Network]: 'A network step failed',
};
