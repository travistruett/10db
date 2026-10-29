import type { FolderInspection } from '@10db/contracts';
import { Button, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { MONO_INPUT } from './folder-field';
import { GATE_SOURCE_LABEL } from './gate-source-label';

const LEAVE_EMPTY = "Leave it empty and you'll check each finished task yourself.";
const NO_CHECK_FOUND = `No check found. ${LEAVE_EMPTY}`;

export interface GateFieldProps {
  readonly value: string;
  readonly candidates: FolderInspection['gateCandidates'];
  readonly onChange: (value: string) => void;
}

/** The command that checks the work: prefilled with the best candidate, every candidate a pill to click. */
export function GateField({ value, candidates, onChange }: GateFieldProps) {
  const empty = value.trim() === '';
  // With candidates offered, an emptied field is the builder's choice, so only the consequence is said.
  const emptyLine = candidates.length === 0 ? NO_CHECK_FOUND : LEAVE_EMPTY;
  return (
    <Stack gap="xs">
      <TextInput
        label="Gate command"
        description={
          <>
            The command that checks the work, such as your tests. A task counts as done only when it
            passes.
            {empty ? (
              <Text span display="block" inherit>
                {emptyLine}
              </Text>
            ) : null}
          </>
        }
        placeholder="make gate"
        styles={MONO_INPUT}
        value={value}
        onChange={(e) => {
          onChange(e.currentTarget.value);
        }}
      />
      {candidates.length > 0 ? (
        <Group gap="xs">
          {candidates.map((candidate) => (
            <Tooltip
              key={candidate.command}
              label={GATE_SOURCE_LABEL[candidate.source]}
              events={{ hover: true, focus: true, touch: false }}
            >
              <Button
                size="compact-xs"
                variant="default"
                ff="monospace"
                aria-label={`${candidate.command}, ${GATE_SOURCE_LABEL[candidate.source]}`}
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
