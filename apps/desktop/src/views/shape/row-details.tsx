import type { ShapeProposalDto } from '@10db/contracts';
import { List, Stack, Text } from '@mantine/core';

// What an opened row says, read-only (editing is a later slice). Text is plain: nothing a model
// wrote is rendered as markup.

function Labelled({ label, children }: { readonly label: string; readonly children: string }) {
  return (
    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
      <Text span size="sm" c="dimmed">
        {label}{' '}
      </Text>
      {children}
    </Text>
  );
}

function Items({ label, items }: { readonly label: string; readonly items: readonly string[] }) {
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

export function RowDetails({ row }: { readonly row: ShapeProposalDto }) {
  switch (row.kind) {
    case 'goal':
      return (
        <Stack gap="xs">
          <Labelled label="Objective">{row.body.objective}</Labelled>
          <Items label="Criteria" items={row.body.criteria.map((c) => `${c.text} (${c.check})`)} />
          <Items
            label="Tasks"
            items={row.body.tasks.map(
              (t) => `${t.title} · ${t.size ?? 'sized by history'} · ${t.areas.join(', ')}`,
            )}
          />
          <Labelled label="Ceremony">{row.body.ceremony}</Labelled>
        </Stack>
      );
    case 'task':
      return (
        <Stack gap="xs">
          {row.body.description === '' ? null : (
            <Labelled label="Description">{row.body.description}</Labelled>
          )}
          <Items label="Criteria" items={row.body.criteria} />
          <Labelled label="Areas">{row.body.areas.join(', ')}</Labelled>
          {row.body.dependsOn.length === 0 ? null : (
            <Labelled label="Depends on">{row.body.dependsOn.join(', ')}</Labelled>
          )}
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
