import { z } from 'zod';

/** Where an agent model's figure comes from. */
export const ModelSource = {
  /** Artificial Analysis's own number for the model. */
  Aa: 'aa',
  /** Artificial Analysis's number, reached through the OpenRouter model it is joined to. */
  AaViaOpenRouter: 'aa_via_openrouter',
  /** OpenRouter's own number. */
  OpenRouter: 'openrouter',
} as const;
export type ModelSource = (typeof ModelSource)[keyof typeof ModelSource];

/** Where a decision model's cost or time comes from. */
export const DecisionNumberSource = {
  /** Measured on the builder's own calls. */
  YourCalls: 'your_calls',
  /** OpenRouter's list price, with no calls to measure from. */
  OpenRouterPrice: 'openrouter_price',
  /** OpenRouter's measurement. */
  OpenRouter: 'openrouter',
  /** A stand-in used when nothing is measured. */
  Assumed: 'assumed',
} as const;
export type DecisionNumberSource = (typeof DecisionNumberSource)[keyof typeof DecisionNumberSource];

/** The source of each figure on a model row; null where the figure is null. */
export const ModelSources = z.object({
  intelligence: z.enum(ModelSource).nullable(),
  coding: z.enum(ModelSource).nullable(),
  agentic: z.enum(ModelSource).nullable(),
  costPerTask: z.enum(ModelSource).nullable(),
  speed: z.enum(ModelSource).nullable(),
});
export type ModelSources = z.infer<typeof ModelSources>;

/** A row's sources when none is known. */
export const noModelSources = (): ModelSources => ({
  intelligence: null,
  coding: null,
  agentic: null,
  costPerTask: null,
  speed: null,
});
