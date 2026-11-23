import { TITLE_MAX, WHY_MAX } from '@10db/contracts';
import { TextInput } from '@mantine/core';

// A task's title and why, written in the New Task form and the drawer.
// Both are one line; the daemon refuses a newline, and `maxLength` stops the length at the field.

interface FieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** The task's one name: the plain-words what, shown everywhere and the pull request's title. */
export function TitleField({ value, onChange }: FieldProps) {
  return (
    <TextInput
      label="Title"
      description="What it does, in a few plain words."
      placeholder="Such as “Odd files can't freeze 10db”"
      maxLength={TITLE_MAX}
      value={value}
      onChange={(e) => {
        onChange(e.currentTarget.value);
      }}
    />
  );
}

/** One optional sentence on why the task matters, at most 200 characters. */
export function WhyField({ value, onChange }: FieldProps) {
  return (
    <TextInput
      label="Why"
      description="Why it matters, in one sentence."
      placeholder="Optional"
      maxLength={WHY_MAX}
      value={value}
      onChange={(e) => {
        onChange(e.currentTarget.value);
      }}
    />
  );
}
