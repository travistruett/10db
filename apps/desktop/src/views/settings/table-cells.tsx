import { ActionIcon, Alert, Badge, Button, Code, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconPencil, IconTrash } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { describePathPattern } from './path-pattern';

/** A badge as wide as its word; a table never cuts it to "AC…". */
export function Pill({
  children,
  color,
}: {
  readonly children: ReactNode;
  readonly color?: string;
}) {
  return (
    <Badge
      size="md"
      tt="none"
      fw={500}
      variant="light"
      color={color ?? 'gray'}
      style={{ minWidth: 'max-content' }}
      styles={{ label: { overflow: 'visible', textOverflow: 'clip' } }}
    >
      {children}
    </Badge>
  );
}

/** Every pattern of a list, one per line in monospace; hovering one says what it means. */
export function PathLines({ paths }: { readonly paths: readonly string[] }) {
  return (
    <Stack gap={2}>
      {paths.map((glob, index) => (
        <Tooltip key={`${String(index)}-${glob}`} label={describePathPattern(glob).words}>
          <Code style={{ width: 'fit-content' }}>{glob}</Code>
        </Tooltip>
      ))}
    </Stack>
  );
}

/** One dimmed line per pattern in an editor: what it means in words. */
export function PathMeanings({ paths }: { readonly paths: readonly string[] }) {
  if (paths.length === 0) return null;
  return (
    <Stack gap={2}>
      {paths.map((glob, index) => (
        <Text key={`${String(index)}-${glob}`} size="xs" c="dimmed">
          <Code>{glob}</Code>
          {` ${describePathPattern(glob).words}`}
        </Text>
      ))}
    </Stack>
  );
}

/** Edit and Remove for one row; neither press reaches the row's own click. */
export function RowActions({
  noun,
  name,
  onEdit,
  onRemove,
  removeBlocked,
}: {
  readonly noun: 'area' | 'hazard';
  readonly name: string;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  /** Why Remove is off, when it is. */
  readonly removeBlocked?: string;
}) {
  return (
    <Group gap={4} wrap="nowrap" justify="flex-end">
      <Tooltip label={`Edit ${noun}`}>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={`Edit ${noun} ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <IconPencil size={16} aria-hidden />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={removeBlocked ?? `Remove ${noun}`}>
        {/* A disabled button gets no pointer events, so the tooltip hangs on its wrapper. */}
        <span>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`Remove ${noun} ${name}`}
            disabled={removeBlocked !== undefined}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <IconTrash size={16} aria-hidden />
          </ActionIcon>
        </span>
      </Tooltip>
    </Group>
  );
}

/** Said in a drawer when its row was changed elsewhere while it was open. */
export function ChangedAlert({
  noun,
  onShowLatest,
}: {
  readonly noun: 'area' | 'hazard';
  readonly onShowLatest: () => void;
}) {
  return (
    <Alert color="yellow" title={`This ${noun} changed`}>
      <Group justify="space-between" wrap="nowrap" align="center">
        <Text size="sm">{`It changed while you were editing, so nothing was saved. Showing the latest replaces your edits.`}</Text>
        <Button variant="default" size="compact-sm" onClick={onShowLatest}>
          Show the Latest
        </Button>
      </Group>
    </Alert>
  );
}
