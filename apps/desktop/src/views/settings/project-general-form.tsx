import { Delivery, WorkspaceMode, type ProjectDto } from '@10db/contracts';
import {
  Button,
  Collapse,
  Group,
  NumberInput,
  SegmentedControl,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Transition,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronDown, IconCircleCheck } from '@tabler/icons-react';
import { useState } from 'react';
import { usePatchProject } from '../../daemon/queries';
import {
  checkGeneral,
  generalValues,
  type GeneralErrors,
  type GeneralValues,
} from './general-values';
import { FlowSelect } from '../board/flow-select';
import { SettingRow, SettingsCard } from './setting-row';

/** Keeps the fields the builder changed and moves the rest to the project's current values. */
function reseed(current: GeneralValues, seed: GeneralValues, next: GeneralValues): GeneralValues {
  return {
    name: current.name === seed.name ? next.name : current.name,
    gateCommand: current.gateCommand === seed.gateCommand ? next.gateCommand : current.gateCommand,
    maxLanes: current.maxLanes === seed.maxLanes ? next.maxLanes : current.maxLanes,
    handoffPct: current.handoffPct === seed.handoffPct ? next.handoffPct : current.handoffPct,
    nudgePct: current.nudgePct === seed.nudgePct ? next.nudgePct : current.nudgePct,
    humanWaitMinutes:
      current.humanWaitMinutes === seed.humanWaitMinutes
        ? next.humanWaitMinutes
        : current.humanWaitMinutes,
    flowId: current.flowId === seed.flowId ? next.flowId : current.flowId,
    budgetCeiling:
      current.budgetCeiling === seed.budgetCeiling ? next.budgetCeiling : current.budgetCeiling,
    delivery: current.delivery === seed.delivery ? next.delivery : current.delivery,
    baseBranch: current.baseBranch === seed.baseBranch ? next.baseBranch : current.baseBranch,
    prTitlePrefix:
      current.prTitlePrefix === seed.prTitlePrefix ? next.prTitlePrefix : current.prTitlePrefix,
    allowedCommands:
      current.allowedCommands === seed.allowedCommands
        ? next.allowedCommands
        : current.allowedCommands,
    sandboxLoopback:
      current.sandboxLoopback === seed.sandboxLoopback
        ? next.sandboxLoopback
        : current.sandboxLoopback,
    workspaceMode:
      current.workspaceMode === seed.workspaceMode ? next.workspaceMode : current.workspaceMode,
    worktreeSeed: sameList(current.worktreeSeed, seed.worktreeSeed)
      ? next.worktreeSeed
      : current.worktreeSeed,
  };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name, i) => name === b[i]);

const asNumber = (value: number | string): number | '' => (typeof value === 'number' ? value : '');

/** Monospace for the typed value only; `ff` on an input would set its label in monospace too. */
const MONO_INPUT = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

/** The project's editable fields (spec §10 Settings): saved as one patch of what changed. */
export function ProjectGeneralForm({ project }: { readonly project: ProjectDto }) {
  const patch = usePatchProject(project.id);
  const [values, setValues] = useState<GeneralValues>(() => generalValues(project));
  // The values the untouched fields were last seeded from; a field still equal to its seed follows the project.
  const [seed, setSeed] = useState<GeneralValues>(() => generalValues(project));
  const [seededFrom, setSeededFrom] = useState(project);
  if (seededFrom !== project) {
    const next = generalValues(project);
    setSeededFrom(project);
    setSeed(next);
    setValues((v) => reseed(v, seed, next));
  }
  const [errors, setErrors] = useState<GeneralErrors>({});
  const [note, setNote] = useState<string | null>(null);
  const [advanced, advancedToggle] = useDisclosure(false);
  const set = (change: Partial<GeneralValues>) => {
    setValues((v) => ({ ...v, ...change }));
    setNote(null);
  };

  function save() {
    const checked = checkGeneral(project, values);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    if (checked.patch === null) {
      setNote('Nothing to change');
      return;
    }
    patch.mutate(checked.patch, {
      onSuccess: () => {
        setNote('Saved');
        // The confirmation fades after a moment; a later edit clears it at once.
        setTimeout(() => {
          setNote((current) => (current === 'Saved' ? null : current));
        }, 4000);
      },
    });
  }

  const pullRequests = values.delivery === Delivery.PullRequest;
  // checkGeneral checks the pull-request fields whatever the delivery, so one with an error stays shown.
  const showPrFields =
    pullRequests || errors.baseBranch !== undefined || errors.prTitlePrefix !== undefined;

  return (
    <Stack gap="xl">
      <SettingsCard>
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
        <SettingRow
          label="Gate command"
          description="Checks the work. A task is done only when it passes."
        >
          <TextInput
            aria-label="Gate command"
            styles={MONO_INPUT}
            value={values.gateCommand}
            error={errors.gateCommand}
            onChange={(e) => {
              set({ gateCommand: e.currentTarget.value });
            }}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="When work is finished">
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
              { value: Delivery.PullRequest, label: 'Pull request' },
              { value: Delivery.Local, label: 'Commit directly' },
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
        {showPrFields ? (
          <SettingRow
            label="Base branch"
            description="Pull requests start from and merge into this branch."
          >
            <TextInput
              aria-label="Base branch"
              styles={MONO_INPUT}
              value={values.baseBranch}
              error={errors.baseBranch}
              onChange={(e) => {
                set({ baseBranch: e.currentTarget.value });
              }}
            />
          </SettingRow>
        ) : null}
        {showPrFields ? (
          <SettingRow
            label="Pull request title"
            description="Starts every title, as a commit type and scope: feat(desktop)."
          >
            <TextInput
              aria-label="Pull request title"
              placeholder="feat(app)"
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

      <SettingsCard title="Running tasks">
        <SettingRow
          label="Most tasks at once"
          description="10db runs fewer when tasks change the same areas or a usage limit is near."
        >
          <NumberInput
            aria-label="Most tasks at once"
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
            label="Where tasks work"
            description={
              values.workspaceMode === WorkspaceMode.Worktree
                ? 'Each task gets its own copy of the repository, so any tasks can run together. You see the work in its pull request.'
                : 'Tasks change files in your checkout, so you can watch them land in your editor and dev server.'
            }
          >
            <SegmentedControl
              aria-label="Where tasks work"
              fullWidth
              value={values.workspaceMode}
              data={[
                { value: WorkspaceMode.Shared, label: 'Your folder' },
                { value: WorkspaceMode.Worktree, label: 'Separate copies' },
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
        {pullRequests && values.workspaceMode === WorkspaceMode.Worktree ? (
          <SettingRow
            label="Copy into each task's copy"
            description="Ignored folders, such as node_modules, copied from this checkout."
          >
            <TagsInput
              aria-label="Copy into each task's copy"
              value={[...values.worktreeSeed]}
              error={errors.worktreeSeed}
              onChange={(worktreeSeed) => {
                set({ worktreeSeed });
              }}
            />
          </SettingRow>
        ) : null}
        <SettingRow
          label="Fresh session"
          description="When a session's memory is this full, it writes a handoff note and a fresh one carries on."
        >
          <NumberInput
            aria-label="Fresh session"
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
      </SettingsCard>

      <Stack gap="xs">
        <Group>
          <Button
            variant="default"
            size="sm"
            onClick={advancedToggle.toggle}
            aria-expanded={advanced}
            rightSection={
              <IconChevronDown
                size={14}
                stroke={1.5}
                style={{
                  transform: advanced ? 'rotate(180deg)' : undefined,
                  transition: 'transform 150ms ease',
                }}
              />
            }
          >
            Advanced
          </Button>
        </Group>
        <Collapse expanded={advanced}>
          <SettingsCard>
            <SettingRow
              label="Flow"
              description="The default steps a task goes through. A task can choose its own."
            >
              <FlowSelect
                aria-label="Flow"
                placeholder="Standard"
                clearable
                value={values.flowId}
                onChange={(flowId) => {
                  set({ flowId });
                }}
              />
            </SettingRow>
            <SettingRow
              label="Firm reminder"
              description="If a session hasn't handed off by this much memory, it is told again, firmly."
            >
              <NumberInput
                aria-label="Firm reminder"
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
              label="Wait for your answer"
              description="After this long, a waiting task pauses and frees its place; it resumes when you answer."
            >
              <NumberInput
                aria-label="Wait for your answer"
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
            <SettingRow
              label="Spending limit per task"
              description="Leave empty for no limit. Models that cost more per task aren't used."
            >
              <NumberInput
                aria-label="Spending limit per task"
                min={0}
                decimalScale={2}
                prefix="$"
                placeholder="No limit"
                value={values.budgetCeiling}
                error={errors.budgetCeiling}
                onChange={(v) => {
                  set({ budgetCeiling: asNumber(v) });
                }}
              />
            </SettingRow>
            <SettingRow
              label="Commands that don't ask"
              description="One per line, such as pnpm test. Tasks run these without asking you; 10db still checks each one."
              stacked
            >
              <Textarea
                aria-label="Commands that don't ask"
                styles={MONO_INPUT}
                autosize
                minRows={1}
                maxRows={10}
                value={values.allowedCommands}
                error={errors.allowedCommands}
                onChange={(e) => {
                  set({ allowedCommands: e.currentTarget.value });
                }}
              />
            </SettingRow>
            <SettingRow
              label="Allow localhost"
              description="For tests that start a local server. Opens every local port to tasks, not just this project's."
            >
              <Group justify="flex-end">
                <Switch
                  aria-label="Allow localhost"
                  checked={values.sandboxLoopback}
                  onChange={(e) => {
                    set({ sandboxLoopback: e.currentTarget.checked });
                  }}
                />
              </Group>
            </SettingRow>
          </SettingsCard>
        </Collapse>
      </Stack>

      {/* The save bar stays at the bottom of the window, so Save never scrolls away. */}
      <Group
        justify="space-between"
        wrap="nowrap"
        pos="sticky"
        bottom={0}
        py="md"
        // Reaches over the shell's bottom padding, so the page ends at the bar: no extra scroll below it.
        mb="calc(var(--app-shell-padding) * -1)"
        bg="var(--mantine-color-body)"
        style={{
          borderTop: '1px solid var(--mantine-color-default-border)',
          // Above controls that layer their own parts (SegmentedControl's labels sit at 2), below popovers.
          zIndex: 'var(--mantine-z-index-app)',
        }}
      >
        <Text size="sm" c="red" role="alert" lineClamp={2}>
          {patch.error ? `Couldn't save: ${patch.error.message}` : ''}
        </Text>
        <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
          {/* Beside the button that caused it, where the eye already is after clicking Save. */}
          <Transition mounted={note !== null && !patch.error} transition="fade" duration={200}>
            {(styles) => (
              <Group gap={4} wrap="nowrap" role="status" style={styles} mr="xs">
                {note === 'Saved' ? (
                  <IconCircleCheck
                    size={18}
                    stroke={1.5}
                    color="var(--mantine-color-green-filled)"
                  />
                ) : null}
                <Text size="sm" fw={500} c={note === 'Saved' ? 'green' : 'dimmed'}>
                  {note}
                </Text>
              </Group>
            )}
          </Transition>
          <Button
            variant="default"
            onClick={() => {
              setValues(generalValues(project));
              setErrors({});
              setNote(null);
            }}
          >
            Reset
          </Button>
          <Button onClick={save} loading={patch.isPending}>
            Save
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
