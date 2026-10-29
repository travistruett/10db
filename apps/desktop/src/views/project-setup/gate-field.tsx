import type { FolderInspection } from '@10db/contracts';
import { Button, Group, Stack, TextInput, Tooltip } from '@mantine/core';
import { MONO_INPUT } from './folder-field';
import { GATE_SOURCE_LABEL } from './gate-source-label';

export const GATE_REQUIRED = 'Enter the command that checks the work';

export interface GateFieldProps {
  readonly value: string;
  readonly candidates: FolderInspection['gateCandidates'];
  readonly onChange: (value: string) => void;
}

/** The command that checks the work: prefilled with the best candidate, every candidate a pill to click. */
export function GateField({ value, candidates, onChange }: GateFieldProps) {
  return (
    <Stack gap="xs">
      <TextInput
        label="Gate command"
        description="The command that checks the work, such as your tests. A task counts as done only when it passes."
        placeholder="make gate"
        styles={MONO_INPUT}
        value={value}
        error={value.trim() === '' ? GATE_REQUIRED : null}
        onChange={(e) => {
          onChange(e.currentTarget.value);
        }}
      />
      {candidates.length > 0 ? (
        <Group gap="xs">
          {candidates.map((candidate) => (
            <Tooltip key={candidate.command} label={GATE_SOURCE_LABEL[candidate.source]}>
              <Button
                size="compact-xs"
                variant="default"
                ff="monospace"
                onClick={() => {
                  onChange(candidate.command);
                }}
              >
                {candidate.command}
              </Button>
            </Tooltip>
          ))}
        </Group>
      ) : null}
    </Stack>
  );
}
