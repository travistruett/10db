import { GUARDRAIL_DIFF_DETAIL, type InboxOption } from '@10db/contracts';

export { GUARDRAIL_DIFF_DETAIL };

/** The answers a card for a lane's stray write to a guardrail file offers, shown as written. */
export const GuardrailStrayChoice = { Keep: 'Keep', Revert: 'Revert' } as const;
export type GuardrailStrayChoice = (typeof GuardrailStrayChoice)[keyof typeof GuardrailStrayChoice];

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
