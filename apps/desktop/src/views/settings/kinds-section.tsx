import type { KindDto } from '@10db/contracts';
import { ActionIcon, Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { useKinds, useMoveKind } from '../../daemon/kind-queries';
import { KindDrawer } from './kind-drawer';
import { rigorLabel } from './rigor-labels';
import { ROLES } from './role-labels';
import { SectionHeading } from './section-heading';

/** The switches a kind has on, as the short words the list shows. */
function switchesOf(kind: KindDto): string[] {
  return [
    kind.alwaysReviewed ? 'Always Reviewed' : null,
    kind.failsAtLimit ? 'Fails at Limit' : null,
    kind.ownCopy ? 'Own Copy' : null,
    kind.toInbox ? 'Inbox' : null,
  ].filter((word) => word !== null);
}

/** A word as a pill that keeps its full width: a table never squeezes it to "Alw…". */
function Pill({ word }: { readonly word: string }) {
  return (
    <Badge
      size="md"
      tt="none"
      fw={500}
      variant="light"
      color="gray"
      style={{ minWidth: 'max-content' }}
      styles={{ label: { overflow: 'visible', textOverflow: 'clip' } }}
    >
      {word}
    </Badge>
  );
}

/** A list of words as pills on one line, or a dimmed dash when there are none. */
function Pills({ words }: { readonly words: readonly string[] }) {
  if (words.length === 0)
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  return (
    <Group gap={4} wrap="nowrap">
      {words.map((word) => (
        <Pill key={word} word={word} />
      ))}
    </Group>
  );
}

const roleName = (role: string): string => ROLES.find((r) => r.role === role)?.label ?? role;

/**
 * The kinds of work a task can be: each with a minimum rigor, safety switches, extra steps and per-role overrides.
 * A row opens its drawer; the arrows set the order the lists show.
 */
export function KindsSection() {
  const kinds = useKinds();
  const move = useMoveKind();
  // The drawer edits this kind, or adds one when `adding`; closing keeps it mounted for its slide out.
  const [editing, setEditing] = useState<KindDto | null>(null);
  const [adding, setAdding] = useState(false);
  const list = kinds.data ?? [];
  const columns: DataTableColumn<KindDto>[] = [
    {
      accessor: 'label',
      title: 'Kind',
      noWrap: true,
      render: (kind) => (
        <Stack gap={0}>
          <Text size="sm" fw={600}>
            {kind.label}
          </Text>
          <Text size="xs" c="dimmed">
            {kind.key}
          </Text>
        </Stack>
      ),
    },
    {
      accessor: 'minimumRigor',
      title: 'Minimum Rigor',
      noWrap: true,
      render: (kind) => (kind.minimumRigor === null ? 'None' : rigorLabel(kind.minimumRigor)),
    },
    {
      accessor: 'switches',
      title: 'Switches',
      noWrap: true,
      render: (kind) => <Pills words={switchesOf(kind)} />,
    },
    {
      accessor: 'impliedBy',
      title: 'Implied By',
      noWrap: true,
      render: (kind) => <Pills words={kind.impliedBy} />,
    },
    {
      accessor: 'addsSteps',
      title: 'Adds',
      noWrap: true,
      render: (kind) => <Pills words={kind.addsSteps.map(roleName)} />,
    },
    {
      accessor: 'overrides',
      title: 'Overrides',
      noWrap: true,
      render: (kind) => <Pills words={Object.keys(kind.overrides).map(roleName)} />,
    },
    {
      accessor: 'order',
      title: 'Order',
      width: 90,
      render: (kind) => {
        const index = list.findIndex((k) => k.id === kind.id);
        return (
          <Group
            gap={2}
            wrap="nowrap"
            // The row's own click opens the drawer; the arrows only move the kind.
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={`Move ${kind.label} up`}
              disabled={index <= 0 || move.isPending}
              onClick={() => {
                move.mutate({ kindId: kind.id, position: index - 1 });
              }}
            >
              <IconArrowUp size={14} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={`Move ${kind.label} down`}
              disabled={index === list.length - 1 || move.isPending}
              onClick={() => {
                move.mutate({ kindId: kind.id, position: index + 1 });
              }}
            >
              <IconArrowDown size={14} />
            </ActionIcon>
          </Group>
        );
      },
    },
  ];
  return (
    <Stack gap="sm" component="section" aria-label="Kinds">
      <SectionHeading
        title="Kinds"
        line="Sorts of work, each with its own care."
        help="A kind is a sort of work with its own care: a floor under the rigor, switches for safety, and a stronger model for some steps."
        action={
          <Button
            onClick={() => {
              setEditing(null);
              setAdding(true);
            }}
          >
            Add Kind
          </Button>
        }
      />
      {kinds.isError ? (
        <Text size="sm" c="red" role="alert">
          {kinds.error.message}
        </Text>
      ) : null}
      {move.isError ? (
        <Text size="sm" c="red" role="alert">
          {move.error.message}
        </Text>
      ) : null}
      <DataTable<KindDto>
        aria-label="Kinds"
        records={list}
        columns={columns}
        idAccessor="id"
        withTableBorder
        backgroundColor="var(--tendb-color-panel)"
        borderRadius="md"
        verticalSpacing="xs"
        horizontalSpacing="md"
        // Too narrow a frame scrolls the table sideways instead of squeezing a column.
        styles={{ table: { minWidth: 1000 } }}
        highlightOnHover
        fetching={kinds.isPending}
        noRecordsText="No kinds yet"
        rowStyle={() => ({ cursor: 'pointer' })}
        onRowClick={({ record }) => {
          setAdding(false);
          setEditing(record);
        }}
      />
      {adding || editing !== null ? (
        <KindDrawer
          // A new drawer per kind, so one kind's draft never leaks into the next.
          key={editing?.id ?? 'new'}
          kind={editing}
          opened
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      ) : null}
    </Stack>
  );
}
