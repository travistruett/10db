import {
  currentStep,
  SAVE_DEV_LOGIN_DESCRIPTION,
  SAVE_DEV_LOGIN_TOOL,
  SaveDevLoginInput,
  SignInCheckState,
  ToolAccess,
  WorkspaceMode,
  type ProjectId,
  type SignInCheckDto,
  type WorkstreamId,
} from '@10db/contracts';
import { getTask, getWorkstreamRow, type DbReader } from '@10db/db';
import { signInSetupTaskOf } from '../inbox';
import { maskedProse, realAccountProblem } from '../pictures';

// The sign-in setup task's lane writes a dev login and hands it to `save_dev_login`. 10db, not the
// agent, decides whether it is saved: only a command its own sign-in check signs the picture browser
// in with, run from the project's folder as the saved command will be.

/** What `save_dev_login` needs of the daemon. */
export interface SignInSetup {
  /** Checks a command not saved yet, as Check Sign-in checks the saved one. */
  check(projectId: ProjectId, command: string): Promise<SignInCheckDto>;
  /** Saves the project's dev login, as Settings › App Preview does. */
  save(projectId: ProjectId, command: string): Promise<void>;
  /** The project's one card says no dev login can work, in these masked words. */
  cannot(projectId: ProjectId, words: { readonly found: string; readonly decide: string }): void;
}

/** Whether the lane's task is the one the project's sign-in card says is setting its sign-in up. */
export function offersSignInSetup(db: DbReader, workstreamId: WorkstreamId): boolean {
  const task = getTask(db, getWorkstreamRow(db, workstreamId).taskId);
  return signInSetupTaskOf(db, task.projectId) === task.id;
}

/** What a check that did not sign in came to, for the agent to fix the command by. */
function checkWords(check: SignInCheckDto, shared: boolean): string {
  const lines = [
    `Not saved. The check came to ${check.state}: ${check.problem ?? 'no reason given'}.`,
    ...(check.exitCode === null ? [] : [`Exit code: ${String(check.exitCode)}.`]),
    ...(check.output === '' ? [] : ['What it printed (masked):', check.output]),
  ];
  if (check.state === SignInCheckState.Unchecked)
    lines.push('That is the app, not the command: start the app at its address and call again.');
  if (!shared)
    lines.push(
      "The check runs from the project's own folder, not this task's copy, so a script this task adds is not there until its work lands. Use a command that needs no new file, or call with cannot naming the script to add.",
    );
  lines.push(`Fix it and call ${SAVE_DEV_LOGIN_TOOL} again, or call it with cannot.`);
  return lines.join('\n');
}

/** The tool as the lane endpoint registers it. */
export function saveDevLoginTool(
  deps: { readonly db: DbReader; readonly signInSetup: SignInSetup },
  workstreamId: WorkstreamId,
): {
  readonly name: string;
  readonly description: string;
  readonly schema: typeof SaveDevLoginInput;
  run(input: SaveDevLoginInput): Promise<string>;
} {
  return {
    name: SAVE_DEV_LOGIN_TOOL,
    description: SAVE_DEV_LOGIN_DESCRIPTION,
    schema: SaveDevLoginInput,
    async run(input) {
      const { db, signInSetup } = deps;
      const row = getWorkstreamRow(db, workstreamId);
      if (currentStep(row).tools === ToolAccess.ReadOnly)
        return 'This step is read-only; only an implement step saves a dev login.';
      if (!offersSignInSetup(db, workstreamId))
        return "The project's sign-in no longer waits on this task, so there is nothing to save.";
      const task = getTask(db, row.taskId);
      if (input.cannot !== undefined) {
        signInSetup.cannot(task.projectId, {
          found: maskedProse(input.cannot.found),
          decide: maskedProse(input.cannot.decide),
        });
        return "Recorded: the builder's card says what you found and what they must decide. Nothing was saved.";
      }
      const command = input.command ?? '';
      const real = realAccountProblem(command);
      if (real !== null) return `Not saved, and not run. ${real}`;
      const check = await signInSetup.check(task.projectId, command);
      if (check.state !== SignInCheckState.SignedIn)
        return checkWords(check, task.workspaceMode === WorkspaceMode.Shared);
      await signInSetup.save(task.projectId, command);
      return `Saved: the command signed the picture browser in and loaded ${check.route ?? 'the app'}. 10db checks it again every day.`;
    },
  };
}
