import { HEADLINE_MAX, WHY_MAX } from '@10db/contracts';
import { TextInput } from '@mantine/core';

// Readable board spec §3, §4: a task's headline and why, written in the New Task form and the drawer.
// Both are one line; the daemon refuses a newline, and `maxLength` stops the length at the field.

interface FieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** The plain-words what: optional, at most 80 characters. The Board falls back to the title. */
export function HeadlineField({ value, onChange }: FieldProps) {
  return (
    <TextInput
      label="Headline"
      description="Optional. A few plain words saying what the task does, such as “Odd files can't freeze 10db”."
      maxLength={HEADLINE_MAX}
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
      description="Optional. One sentence on why it matters, when the headline doesn't say."
      maxLength={WHY_MAX}
      value={value}
      onChange={(e) => {
        onChange(e.currentTarget.value);
      }}
    />
  );
}
