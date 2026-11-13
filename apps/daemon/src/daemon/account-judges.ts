import {
  isModelTier,
  JudgeKind,
  providerOf,
  runsAgents,
  StepRole,
  type AccountJudgeDto,
} from '@10db/contracts';
import { listAccounts, type DbReader } from '@10db/db';
import { chooseModel, IMPLEMENT_NEED } from '../routing';
import type { AgentAdapter } from '../sessions';
import { routingInputs } from '../team';
import { floorReason, floorWhy } from '../trust';

/**
 * Settings › Trust's Judge list: for each account, the model a new task's implement step gets there
 * (by the role's default, never by score, so the list never waits on a measurement), what judges that
 * model's calls, and why 10db's rules do when they do.
 */
export function accountJudges(
  db: DbReader,
  adapter: Pick<AgentAdapter, 'capabilities'>,
): AccountJudgeDto[] {
  // An OpenRouter account answers decisions only and never runs a session, so it has no judge.
  return listAccounts(db).flatMap((account) => {
    const kind = account.kind;
    if (!runsAgents(kind)) return [];
    const choice = chooseModel({
      ...routingInputs(db, { accountId: account.id, provider: providerOf(kind) }),
      def: { role: StepRole.Implement, need: IMPLEMENT_NEED },
      persona: undefined,
      task: { riskTags: [], acceptanceCriteria: [], areas: [], modelSetting: null },
      project: { id: null, budgetCeiling: null },
      stakes: { retry: false },
      byScore: false,
    });
    // A tier's name is what a choice says when the account offers no model for it.
    const model = isModelTier(choice.model) ? null : choice.model;
    const judge = adapter.capabilities({ kind }, model).judge;
    const reason = judge === JudgeKind.Rules ? floorReason({ kind, model, autoMode: true }) : null;
    return {
      accountId: account.id,
      label: account.label,
      model,
      judge,
      why: reason === null ? null : floorWhy(reason),
    };
  });
}
