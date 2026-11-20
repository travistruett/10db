import type { ShapeProposalDto } from '@10db/contracts';
import { Button, Group, NativeSelect, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useState, type KeyboardEvent } from 'react';
import { changedFields, editableFields, filledValues } from './row-editing';
import { OWNS_ESCAPE_ATTRIBUTE } from '../../../conversation/escape';

export interface RowEditorProps {
  readonly row: ShapeProposalDto;
  /** Saves the fields that changed; each becomes the builder's and is pinned. */
  readonly onSave: (fields: Record<string, string>) => void;
  readonly onCancel: () => void;
}

/**
 * Edits a row in place. Only what changed is sent, and the daemon pins it, so the next round
 * leaves it alone. Esc cancels; Save is disabled until something changed.
 */
export function RowEditor({ row, onSave, onCancel }: RowEditorProps) {
  const fields = editableFields(row);
  const [values, setValues] = useState<Record<string, string>>(() => filledValues(row));
  // The row as the editor opened on it: the builder's edits are measured against it, and a round that
  // lands under the editor moves the row but never the builder's text.
  const [opened] = useState(() => ({ round: row.round, values: filledValues(row) }));
  const agentChanged = row.round !== opened.round;
  const changed = changedFields(row, values, opened.values);
  const dirty = Object.keys(changed).length > 0;

  const set = (name: string, value: string): void => {
    setValues((v) => ({ ...v, [name]: value }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && dirty) {
      event.preventDefault();
      onSave(changed);
    }
  };

  return (
    <form
      aria-label="Edit row"
      {...{ [OWNS_ESCAPE_ATTRIBUTE]: '' }}
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) onSave(changed);
      }}
    >
      <Stack gap="xs">
        {fields.map((field, index) => {
          const common = {
            label: field.label,
            value: values[field.name] ?? '',
            size: 'xs' as const,
            // On each control, which is where a key lands: Esc cancels, ⌘↩ saves.
            onKeyDown,
            // The first field takes focus as the editor opens.
            'data-autofocus': index === 0 ? true : undefined,
          };
          if (field.control === 'select')
            return (
              <NativeSelect
                key={field.name}
                {...common}
                data={[...(field.options ?? [])]}
                onChange={(event) => {
                  set(field.name, event.currentTarget.value);
                }}
              />
            );
          if (field.control === 'long')
            return (
              <Textarea
                key={field.name}
                {...common}
                autosize
                minRows={2}
                maxRows={8}
                onChange={(event) => {
                  set(field.name, event.currentTarget.value);
                }}
              />
            );
          return (
            <TextInput
              key={field.name}
              {...common}
              onChange={(event) => {
                set(field.name, event.currentTarget.value);
              }}
            />
          );
        })}
        {agentChanged ? (
          <Text size="xs" c="dimmed" role="status">
            The agent changed this. Save keeps your version of what you edited.
          </Text>
        ) : null}
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" c="dimmed">
            An edited field is pinned: the next round leaves it as you set it.
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Button variant="default" size="xs" onClick={onCancel} onKeyDown={onKeyDown}>
              Cancel
            </Button>
            <Button size="xs" type="submit" disabled={!dirty} onKeyDown={onKeyDown}>
              Save
            </Button>
          </Group>
        </Group>
      </Stack>
    </form>
  );
}
