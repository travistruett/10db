import { Delivery, type FlowId, type ProjectDto } from '@10db/contracts';
import {
  Alert,
  Button,
  Group,
  NumberInput,
  Radio,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { useFlows, usePatchProject } from '../../daemon/queries';
import {
  checkGeneral,
  generalValues,
  type GeneralErrors,
  type GeneralValues,
} from './general-values';
import { PermissionModeField } from './permission-mode-field';

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
    permissionMode:
      current.permissionMode === seed.permissionMode ? next.permissionMode : current.permissionMode,
  };
}

const asNumber = (value: number | string): number | '' => (typeof value === 'number' ? value : '');

/** The project's editable fields (spec §10 Settings): saved as one patch of what changed. */
export function ProjectGeneralForm({ project }: { readonly project: ProjectDto }) {
  const flows = useFlows();
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
  const set = (change: Partial<GeneralValues>) => {
    setValues((v) => ({ ...v, ...change }));
    setNote(null);
  };
  const flowData = (flows.data ?? []).map((f) => ({ value: f.id, label: f.name }));
  // The Select offers only IDs the daemon sent, so looking the string up gives back the branded ID without a cast.
  const flowById = new Map<string, FlowId>((flows.data ?? []).map((f) => [f.id, f.id]));

  function save() {
    const checked = checkGeneral(project, values);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    if (checked.patch === null) {
      setNote('Nothing to change.');
      return;
    }
    patch.mutate(checked.patch, {
      onSuccess: () => {
        setNote('Saved.');
      },
    });
  }

  return (
    <Stack maw={520}>
      <TextInput
        label="Name"
        value={values.name}
        error={errors.name}
        onChange={(e) => {
          set({ name: e.currentTarget.value });
        }}
      />
      <TextInput
        label="Gate command"
        ff="monospace"
        value={values.gateCommand}
        error={errors.gateCommand}
        onChange={(e) => {
          set({ gateCommand: e.currentTarget.value });
        }}
      />
      <Group grow>
        <NumberInput
          label="Lanes"
          min={1}
          max={16}
          value={values.maxLanes}
          error={errors.maxLanes}
          onChange={(v) => {
            set({ maxLanes: asNumber(v) });
          }}
        />
        <NumberInput
          label="Human wait (minutes)"
          min={1}
          max={240}
          value={values.humanWaitMinutes}
          error={errors.humanWaitMinutes}
          onChange={(v) => {
            set({ humanWaitMinutes: asNumber(v) });
          }}
        />
      </Group>
      <Group grow>
        <NumberInput
          label="Handoff at %"
          min={5}
          max={95}
          value={values.handoffPct}
          error={errors.handoffPct}
          onChange={(v) => {
            set({ handoffPct: asNumber(v) });
          }}
        />
        <NumberInput
          label="Nudge at %"
          min={6}
          max={98}
          value={values.nudgePct}
          error={errors.nudgePct}
          onChange={(v) => {
            set({ nudgePct: asNumber(v) });
          }}
        />
      </Group>
      <Select
        label="Flow"
        placeholder="Default (standard)"
        clearable
        data={flowData}
        value={values.flowId}
        onChange={(v) => {
          set({ flowId: v === null ? null : (flowById.get(v) ?? null) });
        }}
      />
      <NumberInput
        label="Budget ceiling per task (USD)"
        description="Empty for no ceiling. Compared with each model profile's cost per task."
        min={0}
        decimalScale={2}
        prefix="$"
        value={values.budgetCeiling}
        error={errors.budgetCeiling}
        onChange={(v) => {
          set({ budgetCeiling: asNumber(v) });
        }}
      />
      <Radio.Group
        label="Delivery"
        value={values.delivery}
        onChange={(value) => {
          set({
            delivery: value === Delivery.PullRequest ? Delivery.PullRequest : Delivery.Local,
          });
        }}
      >
        <Group mt="xs">
          <Radio value={Delivery.Local} label="Commits on the checked-out branch" />
          <Radio value={Delivery.PullRequest} label="One pull request per batch" />
        </Group>
      </Radio.Group>
      {/* Shown in local delivery too: checkGeneral checks both fields whatever the delivery, so an error is never hidden. */}
      <TextInput
        label="Base branch"
        description="The branch on origin each batch starts from and targets"
        ff="monospace"
        value={values.baseBranch}
        error={errors.baseBranch}
        onChange={(e) => {
          set({ baseBranch: e.currentTarget.value });
        }}
      />
      <TextInput
        label="PR title prefix"
        description="A Conventional Commit type and scope; titles read feat(app): <batch title>"
        placeholder="feat(app)"
        ff="monospace"
        value={values.prTitlePrefix}
        error={errors.prTitlePrefix}
        onChange={(e) => {
          set({ prTitlePrefix: e.currentTarget.value });
        }}
      />
      <Textarea
        label="Extra allowed commands"
        description="One command per line, such as pnpm test. A lane runs these without a permission card; the guard still checks each one."
        ff="monospace"
        autosize
        minRows={2}
        value={values.allowedCommands}
        error={errors.allowedCommands}
        onChange={(e) => {
          set({ allowedCommands: e.currentTarget.value });
        }}
      />
      <PermissionModeField
        value={values.permissionMode}
        onChange={(permissionMode) => {
          set({ permissionMode });
        }}
      />
      {patch.error ? (
        <Alert color="red" title="Couldn't save the project">
          {patch.error.message}
        </Alert>
      ) : null}
      <Group>
        <Button onClick={save} loading={patch.isPending}>
          Save
        </Button>
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
        {note ? (
          <Text size="sm" c="dimmed">
            {note}
          </Text>
        ) : null}
      </Group>
    </Stack>
  );
}
