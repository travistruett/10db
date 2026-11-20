import type { ShapeProposalDto } from '@10db/contracts';

// Shape spec §6 Editing. What a builder may set on a row, and what an edit sends: only the fields
// that changed, each of which the daemon pins.

export interface EditableField {
  /** What the edit sends: a field of the row, or `tasks.<key>.<field>` for a goal's task. */
  readonly name: string;
  readonly label: string;
  readonly control: 'text' | 'long' | 'select';
  readonly options?: readonly string[];
  readonly value: string;
  /** The daemon refuses an empty value. */
  readonly required: boolean;
}

/** XL is not offered: a task that big is split (§6). */
const SIZES = ['S', 'M', 'L'] as const;
const CEREMONIES = ['direct', 'spec'] as const;

const text = (name: string, label: string, value: string, required = true): EditableField => ({
  name,
  label,
  control: 'text',
  value,
  required,
});
const long = (name: string, label: string, value: string, required = true): EditableField => ({
  name,
  label,
  control: 'long',
  value,
  required,
});
const choice = (
  name: string,
  label: string,
  value: string,
  options: readonly string[],
): EditableField => ({ name, label, control: 'select', options, value, required: true });

/** A task that is sized by finished tasks it resembles (`basis`) has no size to set by hand. */
const sizeField = (name: string, size: string | undefined): EditableField[] =>
  size === undefined ? [] : [choice(name, 'Size', size, SIZES)];

export function editableFields(row: ShapeProposalDto): EditableField[] {
  switch (row.kind) {
    case 'task':
      return [
        text('title', 'Title', row.body.title),
        long('description', 'Description', row.body.description, false),
        ...sizeField('size', row.body.size),
        choice('ceremony', 'Ceremony', row.body.ceremony, CEREMONIES),
      ];
    case 'goal':
      return [
        text('title', 'Title', row.body.title),
        long('objective', 'Objective', row.body.objective),
        choice('ceremony', 'Ceremony', row.body.ceremony, CEREMONIES),
        ...row.body.tasks.flatMap((task) => [
          text(`tasks.${task.key}.title`, `${task.title}: title`, task.title),
          ...sizeField(`tasks.${task.key}.size`, task.size).map((f) => ({
            ...f,
            label: `${task.title}: size`,
          })),
        ]),
      ];
    case 'decision':
      return [
        long('question', 'Question', row.body.question),
        text('choice', 'Choice', row.body.choice),
        long('rationale', 'Why', row.body.rationale),
      ];
    case 'principle':
      return [
        long('statement', 'Statement', row.body.statement),
        long('rationale', 'Why', row.body.rationale),
      ];
    case 'question':
      return [long('text', 'Question', row.body.text), text('for', 'Asked of', row.body.for)];
    case 'landing':
      return [text('title', 'Title', row.body.title)];
    case 'change_task':
    case 'remove_task':
      return [];
  }
}

/** The row's current value of every editable field, by name. */
export function filledValues(row: ShapeProposalDto): Record<string, string> {
  return Object.fromEntries(editableFields(row).map((f) => [f.name, f.value]));
}

/** What an edit sends: the fields whose trimmed value differs from the row's, and none that is empty yet required. */
export function changedFields(
  row: ShapeProposalDto,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const field of editableFields(row)) {
    const given = values[field.name];
    if (given === undefined) continue;
    const next = given.trim();
    if (next === field.value || (next === '' && field.required)) continue;
    changed[field.name] = next;
  }
  return changed;
}
