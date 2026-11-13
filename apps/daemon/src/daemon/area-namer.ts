import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isModelTier, ModelTier, providerOf, StepRole } from '@10db/contracts';
import { defaultAccountId, getAccountRow, listAccountModels, type DbReader } from '@10db/db';
import type { Launcher } from '../environment';
import type { AreaNamer } from '../folders';
import { chooseModel } from '../routing';
import { CompletionError, type AgentAdapter } from '../sessions';
import { routingInputs } from '../team';

/** The tier that names areas: a cheap, quick model, since naming and merging a few dozen candidates needs no more. */
const NAMING_MODEL = ModelTier.Fast;

export interface AreaNamerDeps {
  readonly adapter: Pick<AgentAdapter, 'complete'>;
  readonly launcher: Pick<Launcher, 'session'>;
  readonly db: DbReader;
  /** Where each question gets its own empty folder to start in. */
  readonly scratchRoot: string;
}

/**
 * Asks the default account's model to name and merge area candidates. The question starts in a new
 * empty folder of 10db's own and carries paths as text: the model gets no tool and no project file,
 * so nothing of the repository is read or run on its behalf.
 */
export function createAreaNamer(deps: AreaNamerDeps): AreaNamer {
  return async (prompt, signal) => {
    const id = defaultAccountId(deps.db);
    if (id === null) throw new CompletionError('There is no default account to ask.');
    const account = getAccountRow(deps.db, id);
    // The tier's model on this account, by the tier's default and never by score, so naming is never refused.
    const choice = chooseModel({
      ...routingInputs(deps.db, { accountId: id, provider: providerOf(account.kind) }),
      def: { role: StepRole.Plan, need: 0 },
      persona: undefined,
      task: {
        riskTags: [],
        acceptanceCriteria: [],
        areas: [],
        modelSetting: { kind: 'tier', tier: NAMING_MODEL },
      },
      project: { id: null, budgetCeiling: null },
      stakes: { retry: false },
      byScore: false,
    });
    if (isModelTier(choice.model))
      throw new CompletionError(`${account.label} offers no model to name areas with.`);
    const launch = deps.launcher.session(account, choice.model, listAccountModels(deps.db, id));
    const cwd = await mkdtemp(join(deps.scratchRoot, 'areas-'));
    try {
      return await deps.adapter.complete({
        cwd,
        prompt,
        model: launch.model,
        env: launch.env,
        account: launch.expect,
        ...(signal === undefined ? {} : { signal }),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
}
