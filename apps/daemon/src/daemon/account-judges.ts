import {
  isModelTier,
  JudgeKind,
  Rigor,
  harnessOf,
  StepRole,
  type AccountJudgeDto,
} from '@10db/contracts';
import { listAccounts, type DbReader } from '@10db/db';
import { chooseModel, resolveSteps } from '../routing';
import type { AgentAdapter } from '../sessions';
import { playbookInputs, routingInputs } from '../team';
import { floorReason, floorWhy } from '../trust';

/**
 * Settings › Trust's Judge list: for each account, the model a new task's implement step gets there
 * (by the Standard Build cell's rung, never by score, so the list never waits on a measurement), what judges that
 * model's calls, and why 10db's rules do when they do.
 */
export function accountJudges(
  db: DbReader,
  adapter: Pick<AgentAdapter, 'capabilities'>,
): AccountJudgeDto[] {
  // An account no harness runs never runs a session, so it has no judge.
  return listAccounts(db).flatMap((account) => {
    const harness = harnessOf(account);
    if (harness === null) return [];
    const agent = { kind: account.kind, harness };
    const build = resolveSteps({
      rigor: Rigor.Standard,
      taskKinds: [],
      ...playbookInputs(db, null),
    }).find((step) => step.role === StepRole.Implement);
    const choice = chooseModel({
      ...routingInputs(db, { accountId: account.id, provider: harness }),
      def: { role: StepRole.Implement, need: build?.need ?? 0 },
      requirements: build?.requirements ?? [{ kind: 'automatic' }],
      effort: build?.effort ?? null,
      fallback: build?.fallback ?? null,
      pinned: false,
      task: { modelSetting: null, effortPin: null },
      project: { budgetCeiling: null },
      byScore: false,
    });
    // A tier's name is what a choice says when the account offers no model for it.
    const model = isModelTier(choice.model) ? null : choice.model;
    const judge = adapter.capabilities(agent, model).judge;
    const reason =
      judge === JudgeKind.Rules
        ? floorReason({ ...agent, model, autoMode: true, tendbReady: false })
        : null;
    return {
      accountId: account.id,
      label: account.label,
      model,
      judge,
      why: reason === null ? null : floorWhy(reason),
    };
  });
}
