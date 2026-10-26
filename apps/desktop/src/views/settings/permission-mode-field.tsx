import { PermissionMode } from '@10db/contracts';
import { Radio, Stack } from '@mantine/core';

/** Narrows the radio group's string value without a cast. */
export function readPermissionMode(value: string): PermissionMode {
  return value === PermissionMode.Auto ? PermissionMode.Auto : PermissionMode.Default;
}

/** How a project's lanes decide permission prompts; shared by Settings and the new-project form. */
export function PermissionModeField({
  value,
  onChange,
}: {
  readonly value: PermissionMode;
  readonly onChange: (mode: PermissionMode) => void;
}) {
  return (
    <Radio.Group
      label="Permissions"
      description="Auto mode is not a security boundary: Claude Code's classifier is policy, and it can approve a command you would have refused."
      value={value}
      onChange={(next) => {
        onChange(readPermissionMode(next));
      }}
    >
      <Stack gap="xs" mt="xs">
        <Radio
          value={PermissionMode.Default}
          label="Ask for each command"
          description="What no rule allows becomes a card."
        />
        <Radio
          value={PermissionMode.Auto}
          label="Auto mode"
          description="Claude Code's classifier approves routine commands; hazard commands and calls it hands to a person still ask."
        />
      </Stack>
    </Radio.Group>
  );
}
