import type { ShapeProposalRow } from '@10db/db';

// Shape spec §6 Editing: an edit reaches the next turn as a note ("The builder set Compact
// density's size to M"). These are the sentences, written from the row the builder acted on.

/** What the builder calls the row: its title, question, statement or text, else its key. */
export function rowLabel(row: Pick<ShapeProposalRow, 'key' | 'body'>): string {
  const body =
    typeof row.body === 'object' && row.body !== null && !Array.isArray(row.body) ? row.body : {};
  for (const field of ['title', 'question', 'statement', 'text', 'why']) {
    const value = body[field];
    if (typeof value === 'string' && value.trim() !== '') return truncate(value.trim(), 60);
  }
  return row.key;
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** A value as a sentence shows it: a string as itself, anything else as JSON, cut short. */
function valueText(value: unknown): string {
  const text =
    typeof value === 'string' ? value : value === undefined ? 'nothing' : JSON.stringify(value);
  return truncate(text.replace(/\s+/g, ' '), 80);
}

/** `tasks.cards.size` is the size of the task `cards`. */
function fieldText(field: string): string {
  const [head, key, name] = field.split('.');
  return head === 'tasks' && key !== undefined && name !== undefined ? `${key} ${name}` : field;
}

export const editNote = (label: string, fields: Readonly<Record<string, unknown>>): string =>
  `The builder set ${Object.entries(fields)
    .map(([field, value]) => `${label}’s ${fieldText(field)} to ${valueText(value)}`)
    .join(' and ')}`;

export const restoreNote = (label: string): string => `The builder restored ${label} and pinned it`;

export const dropNote = (label: string): string =>
  `The builder dropped ${label}; do not propose it again`;

export const unpinNote = (label: string, field: string | undefined): string =>
  field === undefined
    ? `The builder unpinned ${label}`
    : `The builder unpinned ${label}’s ${fieldText(field)}`;
