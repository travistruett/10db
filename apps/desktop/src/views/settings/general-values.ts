import {
  allowedCommandProblem,
  AllowedCommands,
  BranchName,
  Delivery,
  PrTitlePrefix,
  ProjectPatch,
  WorkspaceMode,
  type FlowId,
  type ProjectDto,
} from '@10db/contracts';

/**
 * The seed names trimmed and without blanks, or the contract's message for the first rule they
 * break (a name that is not one directory, or more names than a project may seed).
 */
export function checkSeedNames(names: readonly string[]): {
  readonly names: string[];
  readonly error: string | null;
} {
  const trimmed = names.map((name) => name.trim()).filter((name) => name !== '');
  const checked = ProjectPatch.safeParse({ worktreeSeed: trimmed });
  return {
    names: trimmed,
    error: checked.success ? null : (checked.error.issues[0]?.message ?? 'Check the seed names'),
  };
}

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
  /** One command prefix per line; blank lines are ignored. */
  readonly allowedCommands: string;
  readonly sandboxLoopback: boolean;
  readonly workspaceMode: WorkspaceMode;
  /** Directory names; blanks are dropped on save. */
  readonly worktreeSeed: readonly string[];
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
    allowedCommands: project.allowedCommands.join('\n'),
    sandboxLoopback: project.sandboxLoopback,
    workspaceMode: project.workspaceMode,
    worktreeSeed: project.worktreeSeed,
  };
}

/**
 * The commands on the non-blank lines, trimmed, or the error for the first line that can't be one.
 * The error names the line, so the builder can find it in the box.
 */
function parseAllowedCommands(text: string): { commands: string[]; error: string | null } {
  const commands: string[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const command = line.trim();
    if (command === '') continue;
    const problem = allowedCommandProblem(command);
    if (problem !== null) return { commands, error: `Line ${String(index + 1)}: ${problem}` };
    commands.push(command);
  }
  const listed = AllowedCommands.safeParse(commands);
  return {
    commands,
    error: listed.success
      ? null
      : (listed.error.issues[0]?.message ?? 'Check the allowed commands'),
  };
}

/** Client-side checks with the daemon's rules, and the patch of what differs from the project. */
export function checkGeneral(project: ProjectDto, values: GeneralValues): GeneralCheck {
  const errors: GeneralErrors = {};
  const name = values.name.trim();
  const gateCommand = values.gateCommand.trim();
  const allowed = parseAllowedCommands(values.allowedCommands);
  if (allowed.error !== null) errors.allowedCommands = allowed.error;
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
  if (values.workspaceMode === WorkspaceMode.Worktree && values.delivery !== Delivery.PullRequest)
    errors.workspaceMode = 'A worktree per task needs pull request delivery';
  const checkedSeed = checkSeedNames(values.worktreeSeed);
  if (checkedSeed.error !== null) errors.worktreeSeed = checkedSeed.error;
  const seed = checkedSeed.names;
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
  if (!sameCommands(allowed.commands, project.allowedCommands))
    patch.allowedCommands = allowed.commands;
  if (values.sandboxLoopback !== project.sandboxLoopback)
    patch.sandboxLoopback = values.sandboxLoopback;
  if (values.workspaceMode !== project.workspaceMode) patch.workspaceMode = values.workspaceMode;
  if (!sameCommands(seed, project.worktreeSeed)) patch.worktreeSeed = seed;
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : null };
}

function sameCommands(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((command, i) => command === b[i]);
}
