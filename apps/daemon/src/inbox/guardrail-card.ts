import { BatchId, GUARDRAIL_DIFF_DETAIL, type InboxOption } from '@10db/contracts';
import { z } from 'zod';

export { GUARDRAIL_DIFF_DETAIL };

/** The answers a card for a lane's stray write to a guardrail file offers, shown as written. */
export const GuardrailStrayChoice = { Keep: 'Keep', Revert: 'Revert' } as const;
export type GuardrailStrayChoice = (typeof GuardrailStrayChoice)[keyof typeof GuardrailStrayChoice];

/** The answers a card for a pull request that changes a guardrail offers, shown as written. */
export const GuardrailPrChoice = { Merge: 'Merge', Close: 'Close' } as const;
export type GuardrailPrChoice = (typeof GuardrailPrChoice)[keyof typeof GuardrailPrChoice];

/** The `detail` key of a held pull request's card: the root batch it belongs to and the diff hash it was raised for. */
export const GUARDRAIL_HOLD_DETAIL = 'guardrailHold';

export const GuardrailHoldDetail = z.object({
  batchId: BatchId,
  /** The hash of the guardrail diff the card shows; null when the diff could not be read. */
  hash: z.string().nullable(),
  prUrl: z.string(),
});
export type GuardrailHoldDetail = z.infer<typeof GuardrailHoldDetail>;

/**
 * The title of the card for a pull request that changes guardrails: the label of the first kind, in the
 * list's order, and how many more kinds the pull request touches.
 */
export function guardrailPrTitle(labels: readonly string[]): string {
  const [first, ...more] = labels;
  const name = first ?? 'guardrails';
  return `A change to your ${name}${more.length === 0 ? '' : ` and ${String(more.length)} more`} is ready`;
}

/**
 * What the card offers: Merge approves exactly the diff the card shows and turns on auto-merge, Close closes
 * the pull request. A diff that could not be read can't be approved, so its card only offers Close.
 */
export function guardrailPrOptions(readable: boolean): InboxOption[] {
  const close: InboxOption = {
    label: GuardrailPrChoice.Close,
    description: 'Close the pull request without merging it',
  };
  if (!readable) return [close];
  return [
    {
      label: GuardrailPrChoice.Merge,
      description: 'Approve this diff and let the pull request merge as the batch asked',
    },
    close,
  ];
}

/** The title of the card for the guardrail `label` names, as in "A lane edited your git guard". */
export const guardrailStrayTitle = (label: string): string => `A lane edited your ${label}`;

/** What the card offers: Keep trusts what is there, Revert puts the file back or removes it, keeping a copy. */
export function guardrailStrayOptions(tracked: boolean): InboxOption[] {
  return [
    {
      label: GuardrailStrayChoice.Keep,
      description: 'Stop flagging this exact content at this path',
    },
    {
      label: GuardrailStrayChoice.Revert,
      description: tracked ? 'Put back the committed file' : 'Remove it; a copy is kept',
    },
  ];
}
