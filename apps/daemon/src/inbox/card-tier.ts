import type { CardResolvesWhen } from '@10db/contracts';

/** What a card asks of the builder: an ask needs an answer, a notice is only told, a status shows state. */
export const CardTier = { Ask: 'ask', Notice: 'notice', Status: 'status' } as const;
export type CardTier = (typeof CardTier)[keyof typeof CardTier];

/** What a stored flag can be: a notice is an event and never a card. */
export type StoredTier = typeof CardTier.Ask | typeof CardTier.Status;

/** How an open card closes. */
export type CardClosesWhen =
  | { readonly by: 'answer' }
  | { readonly by: 'event'; readonly when: CardResolvesWhen }
  /** Names the code that withdraws or resolves it. */
  | { readonly by: 'withdrawn'; readonly when: string };

export const BY_ANSWER: CardClosesWhen = { by: 'answer' };
