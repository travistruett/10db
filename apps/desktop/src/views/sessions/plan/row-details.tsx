import type { ShapeProposalDto, ShapeTaskSizeDto } from '@10db/contracts';
import { List, Stack, Text } from '@mantine/core';
import { IconClockExclamation } from '@tabler/icons-react';
import { sizeFacts } from './size-line';

// What an opened row says, read-only (editing is a later slice). Text is plain: nothing a model
// wrote is rendered as markup.

export function Labelled({
  label,
  children,
}: {
  readonly label: string;
  readonly children: string;
}) {
  return (
    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
      <Text span size="sm" c="dimmed">
        {label}{' '}
      </Text>
      {children}
    </Text>
  );
}

export function Items({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <List size="sm" spacing={2} listStyleType="none" withPadding={false}>
        {items.map((item) => (
          <List.Item key={item}>{item}</List.Item>
        ))}
      </List>
    </Stack>
  );
}

/** The size and area of an opened task, once: "repo · ~0.5 h", flagged when it ran outside its size. */
export function SizeFacts({
  areas,
  size,
}: {
  readonly areas: readonly string[];
  readonly size: ShapeTaskSizeDto | undefined;
}) {
  return (
    <Text size="xs" c="dimmed">
      {sizeFacts(areas, size)}
      {size?.missized === true ? (
        <>
          {' '}
          <IconClockExclamation
            size={14}
            stroke={1.5}
            role="img"
            aria-label="Outside its size by more than one bucket"
            style={{ verticalAlign: '-2px' }}
          />
        </>
      ) : null}
    </Text>
  );
}

/** A goal's tasks and their title, size and area are in its card; an opened goal adds what they don't say. */
export function RowDetails({
  row,
  sizes,
}: {
  readonly row: ShapeProposalDto;
  readonly sizes: readonly ShapeTaskSizeDto[];
}) {
  switch (row.kind) {
    case 'goal': {
      const off = sizes.filter((s) => s.missized).length;
      return (
        <Stack gap="xs">
          <Items label="Criteria" items={row.body.criteria.map((c) => `${c.text} (${c.check})`)} />
          <Labelled label="Ceremony">{row.body.ceremony}</Labelled>
          {off === 0 ? null : <Text size="xs" c="dimmed">{`${String(off)} mis-sized`}</Text>}
        </Stack>
      );
    }
    case 'task':
      return (
        <Stack gap="xs">
          {row.body.description === '' ? null : (
            <Labelled label="Description">{row.body.description}</Labelled>
          )}
          <Items label="Criteria" items={row.body.criteria} />
          {row.body.dependsOn.length === 0 ? null : (
            <Labelled label="Depends on">{row.body.dependsOn.join(', ')}</Labelled>
          )}
          <SizeFacts areas={row.body.areas} size={sizes[0]} />
        </Stack>
      );
    case 'decision':
      return (
        <Stack gap="xs">
          <Labelled label="Question">{row.body.question}</Labelled>
          <Labelled label="Why">{row.body.rationale}</Labelled>
        </Stack>
      );
    case 'principle':
      return <Labelled label="Why">{row.body.rationale}</Labelled>;
    case 'question':
      return <Labelled label="Asked of">{row.body.for}</Labelled>;
    case 'landing':
      return <Items label="Lands together" items={row.body.keys} />;
    case 'change_task':
      return (
        <Stack gap="xs">
          {row.body.description === undefined ? null : (
            <Labelled label="Description">{row.body.description}</Labelled>
          )}
          <Items label="Criteria" items={row.body.acceptanceCriteria ?? []} />
          {row.body.areas === undefined ? null : (
            <Labelled label="Areas">{row.body.areas.join(', ')}</Labelled>
          )}
        </Stack>
      );
    case 'remove_task':
      return <Labelled label="Why">{row.body.why}</Labelled>;
  }
}
