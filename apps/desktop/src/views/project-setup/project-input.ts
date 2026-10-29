import { Delivery, type AccountId, type ProjectInput } from '@10db/contracts';

/** One area over the whole repository until Settings splits it, so no two tasks overlap by accident. */
const REPO_AREA = { name: 'repo', globs: ['**'] };
const HANDOFF_PCT = 40;
const NUDGE_PCT = 50;

export interface ProjectChoices {
  readonly name: string;
  /** The repository's top level from the inspection, not the path the builder picked. */
  readonly root: string;
  readonly gateCommand: string;
  readonly delivery: Delivery;
  readonly baseBranch: string;
  /** Set only when the builder could choose between accounts. */
  readonly accountId: AccountId | null;
}

/** What setup sends: the builder's choices over every default the first task doesn't need an answer for. */
export function toProjectInput(choices: ProjectChoices): ProjectInput {
  return {
    name: choices.name.trim(),
    repoPath: choices.root,
    gateCommand: choices.gateCommand.trim(),
    areas: [REPO_AREA],
    handoffPct: HANDOFF_PCT,
    nudgePct: NUDGE_PCT,
    delivery: choices.delivery,
    ...(choices.accountId === null ? {} : { accountId: choices.accountId }),
    // The pull request title prefix is left to Settings, where it is an optional override.
    ...(choices.delivery === Delivery.PullRequest ? { baseBranch: choices.baseBranch.trim() } : {}),
  };
}
