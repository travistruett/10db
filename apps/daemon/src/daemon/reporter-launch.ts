import {
  Effort,
  InvalidError,
  ModelTier,
  StepRole,
  isModelTier,
  type ProjectId,
} from '@10db/contracts';
import { getAccountRow, getProject, listAccountModels, type DbReader } from '@10db/db';
import type { Launcher } from '../environment';
import type { ReporterLaunch } from '../linear';
import { chooseModel } from '../routing';
import { routingInputs } from '../team';

/**
 * What a Linear reporter's session launches on: the project's account at its Efficient tier, by the tier's
 * default and never by score, at low effort. The reporter writes a few comments from facts it is handed, so a
 * cheap quick model is enough, as it is for naming areas.
 */
export function createReporterLaunch(deps: {
  readonly db: DbReader;
  readonly launcher: Pick<Launcher, 'session'>;
}): (projectId: ProjectId) => ReporterLaunch {
  return (projectId) => {
    const project = getProject(deps.db, projectId);
    const row = getAccountRow(deps.db, project.accountId);
    const choice = chooseModel({
      ...routingInputs(deps.db, project),
      def: { role: StepRole.Plan, need: 0 },
      requirements: [{ kind: 'automatic' }],
      effort: Effort.Low,
      fallback: null,
      pinned: false,
      task: { modelSetting: { kind: 'tier', tier: ModelTier.Efficient }, effortPin: Effort.Low },
      project,
      byScore: false,
    });
    if (isModelTier(choice.model))
      throw new InvalidError(`${row.label} offers no model to report to Linear with.`);
    const session = deps.launcher.session(row, choice.model, listAccountModels(deps.db, row.id));
    return {
      cwd: project.repoPath,
      model: session.model,
      modelId: choice.model,
      effort: choice.effort,
      env: session.env,
      account: session.expect,
    };
  };
}
