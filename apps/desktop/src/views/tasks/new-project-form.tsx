import { BillingMode, type ProjectDto } from '@10db/contracts';
import {
  Alert,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useState, type SyntheticEvent } from 'react';
import { useCreateProject } from '../../daemon/queries';
import { parseAreas } from './areas-text';

const BILLING_OPTIONS = [
  { value: BillingMode.Subscription, label: 'Subscription (your Claude plan)' },
  { value: BillingMode.ApiKey, label: 'API key (from the Keychain)' },
  { value: BillingMode.Bedrock, label: 'Amazon Bedrock' },
];
const BILLING_VALUES: readonly string[] = Object.values(BillingMode);

/** Starting heuristics (spec §15); the daemon validates the final values. */
const DEFAULT_HANDOFF_PCT = 40;
const DEFAULT_NUDGE_PCT = 50;
const MAX_NUDGE_PCT = 98;

function isBillingMode(value: string | null): value is BillingMode {
  return value !== null && BILLING_VALUES.includes(value);
}

/** The firm nudge must sit above the handoff threshold. */
function nudgeFor(handoffPct: number): number {
  return Math.min(MAX_NUDGE_PCT, Math.max(DEFAULT_NUDGE_PCT, handoffPct + 1));
}

export function NewProjectForm({
  onCreated,
}: {
  readonly onCreated: (project: ProjectDto) => void;
}) {
  const create = useCreateProject();
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [gateCommand, setGateCommand] = useState('');
  const [areasText, setAreasText] = useState('');
  const [billingMode, setBillingMode] = useState<BillingMode>(BillingMode.Subscription);
  const [handoffPct, setHandoffPct] = useState<number | ''>(DEFAULT_HANDOFF_PCT);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = parseAreas(areasText);
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    if (handoffPct === '') {
      setFormError('Enter the handoff percentage');
      return;
    }
    setFormError(null);
    create.mutate(
      {
        name: name.trim(),
        repoPath: repoPath.trim(),
        gateCommand: gateCommand.trim(),
        areas: parsed.areas,
        billingMode,
        handoffPct,
        nudgePct: nudgeFor(handoffPct),
      },
      {
        onSuccess: (project) => {
          onCreated(project);
        },
      },
    );
  };

  const error = formError ?? create.error?.message ?? null;
  return (
    <form onSubmit={submit} noValidate>
      <Stack>
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
        />
        <TextInput
          label="Repository path"
          description="Absolute path to the git checkout"
          placeholder="/path/to/your/checkout"
          ff="monospace"
          value={repoPath}
          onChange={(e) => {
            setRepoPath(e.currentTarget.value);
          }}
        />
        <TextInput
          label="Gate command"
          description="10db runs this to verify a task is done"
          placeholder="make gate"
          ff="monospace"
          value={gateCommand}
          onChange={(e) => {
            setGateCommand(e.currentTarget.value);
          }}
        />
        <Textarea
          label="Areas"
          description="One per line: name: glob, glob"
          placeholder="src: src/**"
          ff="monospace"
          autosize
          minRows={3}
          value={areasText}
          onChange={(e) => {
            setAreasText(e.currentTarget.value);
          }}
        />
        <Select
          label="Billing"
          data={BILLING_OPTIONS}
          value={billingMode}
          allowDeselect={false}
          onChange={(value) => {
            if (isBillingMode(value)) setBillingMode(value);
          }}
        />
        <NumberInput
          label="Handoff at %"
          description="Context use at which a session hands off to a fresh one"
          allowDecimal={false}
          min={5}
          max={95}
          clampBehavior="strict"
          value={handoffPct}
          onChange={(value) => {
            setHandoffPct(typeof value === 'number' ? value : '');
          }}
        />
        {error ? (
          <Alert color="red" title="Couldn't create the project">
            {error}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button type="submit" loading={create.isPending}>
            Create project
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
