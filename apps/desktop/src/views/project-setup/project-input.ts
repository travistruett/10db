import { Delivery, type AccountId, type AreaDef, type ProjectInput } from '@10db/contracts';

const HANDOFF_PCT = 40;
const NUDGE_PCT = 50;

export interface ProjectChoices {
  readonly name: string;
  /** The repository's top level from the inspection, not the path the builder picked. */
  readonly root: string;
  /** Empty means no gate: the builder checks each finished task. */
  readonly gateCommand: string;
  readonly delivery: Delivery;
  readonly baseBranch: string;
  /** The areas the builder accepted, exactly as they left them. */
  readonly areas: readonly AreaDef[];
  /** Set only when the builder could choose between accounts. */
  readonly accountId: AccountId | null;
}

/** What setup sends: the builder's choices over every default the first task doesn't need an answer for. */
export function toProjectInput(choices: ProjectChoices): ProjectInput {
  return {
    name: choices.name.trim(),
    repoPath: choices.root,
    gateCommand: choices.gateCommand.trim() === '' ? null : choices.gateCommand.trim(),
    areas: [...choices.areas],
    handoffPct: HANDOFF_PCT,
    nudgePct: NUDGE_PCT,
    delivery: choices.delivery,
    ...(choices.accountId === null ? {} : { accountId: choices.accountId }),
    // The pull request title prefix is left to Settings, where it is an optional override.
    ...(choices.delivery === Delivery.PullRequest ? { baseBranch: choices.baseBranch.trim() } : {}),
  };
}
