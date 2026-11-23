import { HEADLINE_MAX, WHY_MAX } from '@10db/contracts';
import { TextInput } from '@mantine/core';

// Readable board spec §3, §4: a task's headline and why, written in the New Task form and the drawer.
// Both are one line; the daemon refuses a newline, and `maxLength` stops the length at the field.

interface FieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/**
 * The plain-words what, at most 80 characters: the headline, which the form calls Title because it is the
 * name the builder sees everywhere. `placeholder` shows what stands in when it is empty.
 */
export function HeadlineField({
  value,
  onChange,
  placeholder = "Such as “Odd files can't freeze 10db”",
}: FieldProps & { readonly placeholder?: string }) {
  return (
    <TextInput
      label="Title"
      description="What it does, in a few plain words."
      placeholder={placeholder}
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

/** The task's title as git sees it (pull request, commit, branch); empty takes the Title. */
export function PullRequestTitleField({ value, onChange }: FieldProps) {
  return (
    <TextInput
      label="Pull Request Title"
      description="What git sees. Empty uses the Title."
      value={value}
      onChange={(e) => {
        onChange(e.currentTarget.value);
      }}
    />
  );
}
