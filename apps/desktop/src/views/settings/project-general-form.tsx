import type { FlowId, ProjectDto } from '@10db/contracts';
import { Alert, Button, Group, NumberInput, Select, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useFlows, usePatchProject } from '../../daemon/queries';
import {
  checkGeneral,
  generalValues,
  type GeneralErrors,
  type GeneralValues,
} from './general-values';

const asNumber = (value: number | string): number | '' => (typeof value === 'number' ? value : '');

/** The project's editable fields (spec §10 Settings): saved as one patch of what changed. */
export function ProjectGeneralForm({ project }: { readonly project: ProjectDto }) {
  const flows = useFlows();
  const patch = usePatchProject(project.id);
  const [values, setValues] = useState<GeneralValues>(() => generalValues(project));
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
