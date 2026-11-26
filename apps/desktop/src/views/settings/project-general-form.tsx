import { Delivery, ProjectLanding, WorkspaceMode, type ProjectDto } from '@10db/contracts';
import {
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TagsInput,
  TextInput,
} from '@mantine/core';
import { asNumber, MONO_INPUT, useProjectFields } from './project-fields-state';
import { ProjectArchiveCard } from './project-archive-card';
import { HiddenFieldAlert } from './hidden-field-alert';
import { SettingRow, SettingsCard } from './setting-row';

/** Said under the default, whichever it is: the default moves no task and needs no idle project. */
const DEFAULT_CHANGE_NOTE =
  'It applies to tasks made from now on and can change while work runs; tasks that already exist keep their own.';

/** The contract a copy app command keeps, said where the builder sets it. */
const COPY_APP_HELP =
  "Starts the copy's own app if it is not running, and prints its address last: an http origin on this Mac, such as http://localhost:9100, never the project's App Address. It runs in the copy's folder under the gate's sandbox with TENDB_COPY_ID set to the copy's id, and it must be safe to repeat. With it, pictures of a copy's work are taken in the copy's app before it lands, and the dev login runs there with TENDB_COPY_ID and TENDB_APP_URL set, so it signs in to the copy's database. Blank, the pictures are taken in the shared app once the copy lands. Stop the copy's app in the Teardown Command.";

const landingChoice = (value: string): ProjectLanding =>
  value === ProjectLanding.Hold
    ? ProjectLanding.Hold
    : value === ProjectLanding.Branch
      ? ProjectLanding.Branch
      : ProjectLanding.Merge;

/** The project's name, checks, delivery and how many tasks run at once: saved as one patch of what changed. */
export function ProjectGeneralForm({ project }: { readonly project: ProjectDto }) {
  const fields = useProjectFields(project, [
    'name',
    'gateCommand',
    'changedCheckCommand',
    'precheckCommand',
    'maxLanes',
    'handoffPct',
    'nudgePct',
    'humanWaitMinutes',
    'delivery',
    'baseBranch',
    'landing',
    'landingBranch',
    'prTitlePrefix',
    'workspaceMode',
    'worktreeSeed',
    'isolate',
    'localCopies',
    'copyTeardownCommand',
    'copyAppCommand',
  ]);
  const { values, errors, set } = fields;
  const pullRequests = values.delivery === Delivery.PullRequest;
  // checkGeneral checks the pull-request fields whatever the delivery, so one with an error stays shown.
  const showPrFields =
    pullRequests || errors.baseBranch !== undefined || errors.prTitlePrefix !== undefined;

  const showCopyFields =
    values.delivery === Delivery.Local || errors.copyTeardownCommand !== undefined;

  return (
    <Stack gap="xl">
      <SettingsCard title="Project">
        <SettingRow label="Name">
          <TextInput
            aria-label="Name"
            value={values.name}
            error={errors.name}
            onChange={(e) => {
              set({ name: e.currentTarget.value });
            }}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="Checks">
        <SettingRow
          label="Gate Command"
          description={
            values.gateCommand.trim() === ''
              ? 'No automatic check: each finished task waits for you.'
              : 'Checks the work. A task is done only when it passes.'
          }
        >
          <TextInput
            aria-label="Gate Command"
            styles={MONO_INPUT}
            value={values.gateCommand}
            error={errors.gateCommand}
            onChange={(e) => {
              set({ gateCommand: e.currentTarget.value });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Check After Each Step"
          description="Runs after each step in place of the gate."
          help="Runs after each step instead of the gate command; the gate command still runs before the push."
        >
          <TextInput
            aria-label="Check After Each Step"
            placeholder="Optional"
            styles={MONO_INPUT}
            value={values.changedCheckCommand}
            error={errors.changedCheckCommand}
            onChange={(e) => {
              set({ changedCheckCommand: e.currentTarget.value });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Pre-Check Command"
          description="Stands in for the gate when GitHub has required checks."
          help="Runs on the Mac in place of the gate when the pull request's base branch has required checks on GitHub. Leave it empty to keep running the gate."
        >
          <TextInput
            aria-label="Pre-Check Command"
            styles={MONO_INPUT}
            value={values.precheckCommand}
            error={errors.precheckCommand}
            onChange={(e) => {
              set({ precheckCommand: e.currentTarget.value });
            }}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="When Work Is Finished">
        <SettingRow
          label="Delivery"
          description={
            pullRequests
              ? 'Work goes to GitHub as a pull request for you to review.'
              : 'Work is committed straight to the branch checked out in this folder.'
          }
        >
          <SegmentedControl
            aria-label="Delivery"
            fullWidth
            value={values.delivery}
            data={[
              { value: Delivery.PullRequest, label: 'Pull Request' },
              { value: Delivery.Local, label: 'Commit Directly' },
            ]}
            onChange={(value) => {
              const delivery =
                value === Delivery.PullRequest ? Delivery.PullRequest : Delivery.Local;
              // A worktree per task needs pull-request delivery, so leaving it returns to the shared checkout.
              set(
                delivery === Delivery.PullRequest
                  ? { delivery }
                  : { delivery, workspaceMode: WorkspaceMode.Shared },
              );
            }}
          />
        </SettingRow>
        {showCopyFields ? (
          <SettingRow
            label="Separate Copies"
            description="A task can run in its own copy and lands only after review and the gate."
            help="A task you place in a Separate Copy gets its own branch, folder and databases. 10db moves the base branch to its work only after review accepts it and the gate passes on the exact commit that lands, by fast-forward. One copy runs at a time. Changing Delivery waits until no copy is unfinished."
          >
            <Group justify="flex-end">
              <Switch
                aria-label="Separate Copies"
                checked={values.localCopies}
                onChange={(e) => {
                  set({ localCopies: e.currentTarget.checked });
                }}
              />
            </Group>
          </SettingRow>
        ) : null}
        {showCopyFields && (values.localCopies || errors.copyTeardownCommand !== undefined) ? (
          <SettingRow
            label="Teardown Command"
            description="Runs when a copy is retired; it drops the copy's databases."
            help="Run in a fresh checkout of the commit the copy was cut from, with TENDB_COPY_ID set to the copy's id. It must be safe to run twice."
          >
            <TextInput
              aria-label="Teardown Command"
              styles={MONO_INPUT}
              value={values.copyTeardownCommand}
              error={errors.copyTeardownCommand}
              onChange={(e) => {
                set({ copyTeardownCommand: e.currentTarget.value });
              }}
            />
          </SettingRow>
        ) : null}
        {showCopyFields && (values.localCopies || values.copyAppCommand.trim() !== '') ? (
          <SettingRow
            label="Copy App Command"
            description="Prints a copy's own app address, so its pictures are taken before it lands."
            help={COPY_APP_HELP}
          >
            <TextInput
              aria-label="Copy App Command"
              styles={MONO_INPUT}
              value={values.copyAppCommand}
              placeholder="Blank: pictures are taken after the copy lands"
              onChange={(e) => {
                set({ copyAppCommand: e.currentTarget.value });
              }}
            />
          </SettingRow>
        ) : null}
        {showPrFields ? (
          <SettingRow
            label="Base Branch"
            description="Pull requests start from and merge into this branch."
          >
            <TextInput
              aria-label="Base Branch"
              styles={MONO_INPUT}
              value={values.baseBranch}
              error={errors.baseBranch}
              onChange={(e) => {
                set({ baseBranch: e.currentTarget.value });
              }}
            />
          </SettingRow>
        ) : null}
        {pullRequests ? (
          <SettingRow
            label="When Checks Pass"
            description={
              values.landing === ProjectLanding.Hold
                ? 'Pull requests wait for you to merge them.'
                : 'GitHub merges each pull request once its checks pass.'
            }
            help={
              values.landing === ProjectLanding.Hold
                ? 'A task can choose to merge.'
                : `GitHub merges each pull request into ${(values.landing === ProjectLanding.Branch ? values.landingBranch.trim() : values.baseBranch.trim()) || 'the base branch'} by itself once its required checks pass. A task can choose another branch, or hold.`
            }
          >
            <Select
              aria-label="When Checks Pass"
              allowDeselect={false}
              checkIconPosition="right"
              value={values.landing}
              data={[
                {
                  value: ProjectLanding.Merge,
                  label: `Merge Into ${values.baseBranch.trim() || 'the base branch'}`,
                },
                { value: ProjectLanding.Branch, label: 'Merge Into a Branch' },
                { value: ProjectLanding.Hold, label: 'Hold for My Review' },
              ]}
              onChange={(value) => {
                if (value !== null) set({ landing: landingChoice(value) });
              }}
            />
          </SettingRow>
        ) : null}
        {pullRequests && values.landing === ProjectLanding.Branch ? (
          <SettingRow
            label="New Tasks Land In"
            description="A branch on origin where new tasks land."
            help="A branch on origin, such as an integration branch. Each new task starts out landing there; a task can choose another place."
          >
            <TextInput
              aria-label="New Tasks Land In"
              placeholder="next"
              styles={MONO_INPUT}
              value={values.landingBranch}
              error={errors.landingBranch}
              onChange={(e) => {
                set({ landingBranch: e.currentTarget.value });
              }}
            />
          </SettingRow>
        ) : null}
        {showPrFields ? (
          <SettingRow
            label="Pull Request Title"
            description="Starts every title, such as feat(desktop)."
            help="Left empty, 10db writes <type>(<scope>): <subject> from the batch's tasks and the paths it changed."
          >
            <TextInput
              aria-label="Pull Request Title"
              placeholder="feat(app) (optional)"
              styles={MONO_INPUT}
              value={values.prTitlePrefix}
              error={errors.prTitlePrefix}
              onChange={(e) => {
                set({ prTitlePrefix: e.currentTarget.value });
              }}
            />
          </SettingRow>
        ) : null}
      </SettingsCard>

      <SettingsCard title="Running Tasks">
        <SettingRow
          label="Most Tasks at Once"
          description="10db runs fewer when tasks change the same areas or a usage limit is near."
        >
          <NumberInput
            aria-label="Most Tasks at Once"
            min={1}
            max={16}
            value={values.maxLanes}
            error={errors.maxLanes}
            onChange={(v) => {
              set({ maxLanes: asNumber(v) });
            }}
          />
        </SettingRow>
        {pullRequests ? (
          <SettingRow
            label="Default for New Tasks"
            description={
              values.workspaceMode === WorkspaceMode.Worktree
                ? 'Each task works in its own copy of the repository.'
                : 'Tasks change files in your checkout.'
            }
            help={`${
              values.workspaceMode === WorkspaceMode.Worktree
                ? 'Separate copy: each new task works in its own copy of the repository under ~/.10db/worktrees, so any tasks can run together. Your checkout is left alone. You see the work in its pull request.'
                : 'Your folder: new tasks change files in your checkout, so you can watch them land in your editor and dev server. While they run, 10db switches this checkout to a new branch cut from the base branch, and it needs the checkout clean (no uncommitted changes) to start. When the batch ships, closes or is abandoned, 10db switches the checkout back to where it was, as long as it is still on that branch with nothing uncommitted. Otherwise 10db leaves it where it is, and a card says why unless you moved it yourself.'
            } ${DEFAULT_CHANGE_NOTE}`}
          >
            <SegmentedControl
              aria-label="Default for New Tasks"
              fullWidth
              value={values.workspaceMode}
              data={[
                { value: WorkspaceMode.Shared, label: 'Your Folder' },
                { value: WorkspaceMode.Worktree, label: 'Separate Copy' },
              ]}
              onChange={(value) => {
                set({
                  workspaceMode:
                    value === WorkspaceMode.Worktree
                      ? WorkspaceMode.Worktree
                      : WorkspaceMode.Shared,
                });
              }}
            />
          </SettingRow>
        ) : null}
        {pullRequests ? (
          <SettingRow
            label="Separate Copy for These Areas"
            description="Area and hazard names that get their own copy."
            help="Area and hazard names, such as migrations or deps. A new task that names one is proposed a separate copy, and its card says why. Changing the list moves no task that already exists."
          >
            <TagsInput
              aria-label="Separate Copy for These Areas"
              value={[...values.isolate]}
              error={errors.isolate}
              onChange={(isolate) => {
                set({ isolate });
              }}
            />
          </SettingRow>
        ) : null}
        {pullRequests ? (
          <SettingRow
            label="Copy Into Each Task's Copy"
            description="Ignored folders, such as node_modules, copied from this checkout."
          >
            <TagsInput
              aria-label="Copy Into Each Task's Copy"
              value={[...values.worktreeSeed]}
              error={errors.worktreeSeed}
              onChange={(worktreeSeed) => {
                set({ worktreeSeed });
              }}
            />
          </SettingRow>
        ) : null}
        <SettingRow
          label="Fresh Session"
          description="When a session's memory is this full, it writes a handoff note and a fresh one carries on."
        >
          <NumberInput
            aria-label="Fresh Session"
            suffix="%"
            min={5}
            max={95}
            value={values.handoffPct}
            error={errors.handoffPct}
            onChange={(v) => {
              set({ handoffPct: asNumber(v) });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Firm Reminder"
          description="If a session hasn't handed off by this much memory, it is told again, firmly."
        >
          <NumberInput
            aria-label="Firm Reminder"
            suffix="%"
            min={6}
            max={98}
            value={values.nudgePct}
            error={errors.nudgePct}
            onChange={(v) => {
              set({ nudgePct: asNumber(v) });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Wait for Your Answer"
          description="After this long, a waiting task pauses and frees its place; it resumes when you answer."
        >
          <NumberInput
            aria-label="Wait for Your Answer"
            suffix=" min"
            min={1}
            max={240}
            value={values.humanWaitMinutes}
            error={errors.humanWaitMinutes}
            onChange={(v) => {
              set({ humanWaitMinutes: asNumber(v) });
            }}
          />
        </SettingRow>
      </SettingsCard>

      <ProjectArchiveCard project={project} />

      <HiddenFieldAlert fields={fields} />
    </Stack>
  );
}
