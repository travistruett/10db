import {
  BranchName,
  Delivery,
  PrTitlePrefix,
  type FlowId,
  type ProjectDto,
  type ProjectPatch,
} from '@10db/contracts';

/** The General form's fields; an emptied number field is ''. */
export interface GeneralValues {
  readonly name: string;
  readonly gateCommand: string;
  readonly maxLanes: number | '';
  readonly handoffPct: number | '';
  readonly nudgePct: number | '';
  readonly humanWaitMinutes: number | '';
  readonly flowId: FlowId | null;
  /** '' means no ceiling. */
  readonly budgetCeiling: number | '';
  readonly delivery: Delivery;
  readonly baseBranch: string;
  /** '' means none. */
  readonly prTitlePrefix: string;
}

export type GeneralErrors = Partial<Record<keyof GeneralValues, string>>;
export type GeneralCheck =
  | { readonly ok: true; readonly patch: ProjectPatch | null }
  | { readonly ok: false; readonly errors: GeneralErrors };

export function generalValues(project: ProjectDto): GeneralValues {
  return {
    name: project.name,
    gateCommand: project.gateCommand,
    maxLanes: project.maxLanes,
    handoffPct: project.handoffPct,
    nudgePct: project.nudgePct,
    humanWaitMinutes: project.humanWaitMinutes,
    flowId: project.flowId,
    budgetCeiling: project.budgetCeiling ?? '',
    delivery: project.delivery,
    baseBranch: project.baseBranch,
    prTitlePrefix: project.prTitlePrefix ?? '',
  };
}

/** Client-side checks with the daemon's rules, and the patch of what differs from the project. */
export function checkGeneral(project: ProjectDto, values: GeneralValues): GeneralCheck {
  const errors: GeneralErrors = {};
  const name = values.name.trim();
  const gateCommand = values.gateCommand.trim();
  if (name === '') errors.name = 'Enter a name';
  if (gateCommand === '') errors.gateCommand = 'Enter the gate command';
  if (values.maxLanes === '') errors.maxLanes = 'Enter the lane cap';
  if (values.handoffPct === '') errors.handoffPct = 'Enter the handoff percentage';
  if (values.nudgePct === '') errors.nudgePct = 'Enter the nudge percentage';
  else if (values.handoffPct !== '' && values.nudgePct <= values.handoffPct)
    errors.nudgePct = 'The nudge must come after the handoff';
  if (values.humanWaitMinutes === '') errors.humanWaitMinutes = 'Enter the wait in minutes';
  if (values.budgetCeiling !== '' && values.budgetCeiling <= 0)
    errors.budgetCeiling = 'Enter a ceiling above $0, or leave it empty for none';
  const baseBranch = values.baseBranch.trim();
  const prefix = values.prTitlePrefix.trim();
  if (!BranchName.safeParse(baseBranch).success)
    errors.baseBranch = 'Enter the base branch, such as main';
  if (
    (values.delivery === Delivery.PullRequest || prefix !== '') &&
    !PrTitlePrefix.safeParse(prefix).success
  )
    errors.prTitlePrefix = 'Enter a PR title prefix such as feat(app)';
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const patch: { -readonly [K in keyof ProjectPatch]: ProjectPatch[K] } = {};
  if (name !== project.name) patch.name = name;
  if (gateCommand !== project.gateCommand) patch.gateCommand = gateCommand;
  if (values.maxLanes !== '' && values.maxLanes !== project.maxLanes)
    patch.maxLanes = values.maxLanes;
  if (values.handoffPct !== '' && values.handoffPct !== project.handoffPct)
    patch.handoffPct = values.handoffPct;
  if (values.nudgePct !== '' && values.nudgePct !== project.nudgePct)
    patch.nudgePct = values.nudgePct;
  if (values.humanWaitMinutes !== '' && values.humanWaitMinutes !== project.humanWaitMinutes)
    patch.humanWaitMinutes = values.humanWaitMinutes;
  if (values.flowId !== project.flowId) patch.flowId = values.flowId;
  const ceiling = values.budgetCeiling === '' ? null : values.budgetCeiling;
  if (ceiling !== project.budgetCeiling) patch.budgetCeiling = ceiling;
  if (values.delivery !== project.delivery) patch.delivery = values.delivery;
  if (baseBranch !== project.baseBranch) patch.baseBranch = baseBranch;
  const prTitlePrefix = prefix === '' ? null : prefix;
  if (prTitlePrefix !== project.prTitlePrefix) patch.prTitlePrefix = prTitlePrefix;
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : null };
}
