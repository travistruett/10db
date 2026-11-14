import { z } from 'zod';

/** One of OpenRouter's decision models, as Settings › Decisions offers it. */
export const DecisionModelDto = z.object({
  /** The OpenRouter model id a decision's `model` is set to. */
  id: z.string(),
  /** OpenRouter's name, without its maker prefix. */
  name: z.string(),
  /** Who makes it, from OpenRouter's name ("TypeSafe", "Liquid"). */
  maker: z.string(),
  /** A router id that always resolves to the maker's newest model of the family (`~maker/...-latest`). */
  latest: z.boolean(),
  /** US dollars per million input tokens. */
  inputUsdPerMillion: z.number().nonnegative(),
  /** US dollars per million output tokens; decision models answer in a few tokens and most charge nothing. */
  outputUsdPerMillion: z.number().nonnegative(),
  /** Why 10db can't call it yet, in the builder's words; null when it can. */
  cantCall: z.string().nullable(),
});
export type DecisionModelDto = z.infer<typeof DecisionModelDto>;

/** `GET /judge/models`: OpenRouter's decision models, read by the daemon and kept for a few hours. */
export const DecisionModelListDto = z.object({
  models: z.array(DecisionModelDto),
  /** When the daemon read the list from OpenRouter. */
  fetchedAt: z.iso.datetime(),
});
export type DecisionModelListDto = z.infer<typeof DecisionModelListDto>;
