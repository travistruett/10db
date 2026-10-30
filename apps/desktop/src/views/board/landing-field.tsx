import { Radio, Stack, Text, TextInput } from '@mantine/core';
import { landingOptions, type LandingDraft } from './landing-draft';

export interface LandingFieldProps {
  /** The project's base branch, named in the first choice. */
  readonly baseBranch: string;
  readonly value: LandingDraft;
  readonly onChange: (draft: LandingDraft) => void;
  /** Why the typed branch is not usable, shown under its box. */
  readonly error?: string | null | undefined;
  readonly disabled?: boolean;
}

/** The three places a task's pull request can land, and the branch box for another branch. */
export function LandingField({
  baseBranch,
  value,
  onChange,
  error = null,
  disabled = false,
}: LandingFieldProps) {
  return (
    <Stack gap="xs">
      <Radio.Group
        label="Where it lands"
        description="Merging happens on GitHub, once the pull request's required checks pass."
        value={value.kind}
        onChange={(kind) => {
          const option = landingOptions(baseBranch).find((o) => o.value === kind);
          if (option) onChange({ ...value, kind: option.value });
        }}
      >
        <Stack gap={6} mt="xs">
          {landingOptions(baseBranch).map((option) => (
            <Radio
              key={option.value}
              value={option.value}
              label={option.label}
              disabled={disabled}
            />
          ))}
        </Stack>
      </Radio.Group>
      {value.kind === 'branch' ? (
        <TextInput
          label="Branch to merge into"
          description="It has to exist on origin. The task is built from it, and its pull request merges into it."
          placeholder="feature/search"
          disabled={disabled}
          value={value.branch}
          error={error}
          onChange={(e) => {
            onChange({ ...value, branch: e.currentTarget.value });
          }}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
        />
      ) : null}
      {value.kind === 'hold' ? (
        <Text size="xs" c="dimmed">
          The pull request opens and stays open for you to merge.
        </Text>
      ) : null}
    </Stack>
  );
}
