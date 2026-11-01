import { Delivery, type ProjectDto } from '@10db/contracts';

/** What runs on the Mac: the pre-check, or the gate (or the changed-packages check standing for it). */
export interface LocalCheck {
  readonly kind: 'precheck' | 'gate';
  readonly command: string;
}

type CheckProject = Pick<
  ProjectDto,
  'delivery' | 'gateCommand' | 'changedCheckCommand' | 'precheckCommand'
>;

/**
 * The pre-check, when the project sets one and its work goes out as a pull request (CI-decides spec
 * §3). A pre-check needs a gate command, so a project without one never has it.
 */
function precheckOf(project: CheckProject): LocalCheck | null {
  if (project.gateCommand === null || project.precheckCommand === null) return null;
  if (project.delivery !== Delivery.PullRequest) return null;
  return { kind: 'precheck', command: project.precheckCommand };
}

/**
 * The check after each implement step: the pre-check, else the changed-packages check, else the gate.
 * Null for a project with no gate command, where the builder checks each step.
 */
export function stepCheck(project: CheckProject): LocalCheck | null {
  if (project.gateCommand === null) return null;
  return (
    precheckOf(project) ?? {
      kind: 'gate',
      command: project.changedCheckCommand ?? project.gateCommand,
    }
  );
}

/**
 * The check before the push, after the base update: the pre-check, else the full gate. Null for a
 * project with no gate command.
 */
export function shipCheck(project: CheckProject): LocalCheck | null {
  if (project.gateCommand === null) return null;
  return precheckOf(project) ?? { kind: 'gate', command: project.gateCommand };
}
