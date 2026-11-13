import { z } from 'zod';
import { Provider } from './states';

type ValueOf<T> = T[keyof T];

/** How a message sent mid-turn reaches the agent: into the running turn, or after it. */
export const SteerMode = { Inject: 'inject', Queue: 'queue' } as const;
export type SteerMode = ValueOf<typeof SteerMode>;

/** When the agent can take another model: from the next turn, or never mid-session. */
export const ModelSwitch = { NextTurn: 'next_turn', None: 'none' } as const;
export type ModelSwitch = ValueOf<typeof ModelSwitch>;

export const ImageFormat = { Png: 'png', Jpeg: 'jpeg', Webp: 'webp' } as const;
export type ImageFormat = ValueOf<typeof ImageFormat>;

/**
 * Who judges a call against the trust line's policy (trust line §4): the agent's own judge (Claude
 * Code's auto mode), 10db's judge, or the guard's rules alone, where no judge runs.
 */
export const JudgeKind = { Native: 'native', Tendb: 'tendb', Rules: 'rules' } as const;
export type JudgeKind = ValueOf<typeof JudgeKind>;

/** What an agent can do (sessions spec §5.3): the UI reads this, never the provider. */
export const AgentCapabilitiesDto = z.strictObject({
  harness: z.enum(Provider),
  /** The agent's name as the UI shows it. */
  label: z.string().min(1),
  steer: z.enum(SteerMode),
  /** The agent says which sent messages a turn took. */
  receipts: z.boolean(),
  /** The agent's conversation can be read back after a restart. */
  readBack: z.boolean(),
  images: z.array(z.enum(ImageFormat)),
  slashCommands: z.boolean(),
  plan: z.boolean(),
  reasoning: z.boolean(),
  subagents: z.boolean(),
  modelSwitch: z.enum(ModelSwitch),
  /** The builder can take the session over in a terminal. */
  takeover: z.boolean(),
  /** The agent's dollar cost is real money, billed per token. */
  costUsd: z.boolean(),
  judge: z.enum(JudgeKind),
});
export type AgentCapabilitiesDto = z.infer<typeof AgentCapabilitiesDto>;
