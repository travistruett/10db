import { SettingField } from '@10db/contracts';
import { Alert, Checkbox, Stack, Text, TextInput } from '@mantine/core';
import type { SettingDraft } from './setting-drafts';

// Workbench setup, Settings: one tick row per suggested setting, its value editable in place, with
// where it was found. Allow Docker has no value and shows its warning while ticked.

/** The setting's name on its row. */
const LABELS: Record<SettingField, string> = {
  [SettingField.AppUrl]: 'App address',
  [SettingField.DevLoginCommand]: 'Sign-in for pictures',
  [SettingField.ChangedCheckCommand]: 'Check after each turn',
  [SettingField.SandboxDocker]: 'Allow Docker',
};

export type SettingChange = Partial<Pick<SettingDraft, 'ticked' | 'value'>>;

export interface SettingRowsProps {
  readonly drafts: readonly SettingDraft[];
  readonly onChange: (field: SettingField, change: SettingChange) => void;
}

function SettingRow({
  draft,
  onChange,
}: {
  readonly draft: SettingDraft;
  readonly onChange: (change: SettingChange) => void;
}) {
  const label = LABELS[draft.field];
  const docker = draft.field === SettingField.SandboxDocker;
  const note = draft.suggestion.note;
  return (
    <Stack gap={4} role="group" aria-label={label}>
      <Checkbox
        label={label}
        checked={draft.ticked}
        onChange={(event) => {
          onChange({ ticked: event.currentTarget.checked });
        }}
      />
      <Stack gap={4} pl={30}>
        {docker ? null : (
          <TextInput
            aria-label={`${label} value`}
            value={draft.value}
            disabled={!draft.ticked}
            error={draft.ticked && draft.value.trim() === '' ? 'Empty: not saved' : undefined}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            onChange={(event) => {
              onChange({ value: event.currentTarget.value });
            }}
          />
        )}
        <Text size="xs" c="dimmed">
          {draft.suggestion.source}
        </Text>
        {note === undefined ? null : docker ? (
          draft.ticked ? (
            <Alert color="yellow" variant="light" p="xs">
              <Text size="sm">{note}</Text>
            </Alert>
          ) : null
        ) : (
          <Text size="xs" c="dimmed">
            {note}
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

/** The suggested settings, in the order the daemon gives them. */
export function SettingRows({ drafts, onChange }: SettingRowsProps) {
  return (
    <Stack gap="md">
      {drafts.map((draft) => (
        <SettingRow
          key={draft.field}
          draft={draft}
          onChange={(change) => {
            onChange(draft.field, change);
          }}
        />
      ))}
    </Stack>
  );
}
