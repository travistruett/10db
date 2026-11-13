import type { KindDto } from '@10db/contracts';
import { ActionIcon, Badge, Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { useKinds, useMoveKind } from '../../daemon/kind-queries';
import { KindDrawer } from './kind-drawer';
import { rigorLabel } from './rigor-labels';
import { ROLES } from './role-labels';

/** The switches a kind has on, as the short words the list shows. */
function switchesOf(kind: KindDto): string[] {
  return [
    kind.alwaysReviewed ? 'Reviewed' : null,
    kind.failsAtLimit ? 'Fails at limit' : null,
    kind.ownCopy ? 'Own copy' : null,
    kind.toInbox ? 'Inbox' : null,
  ].filter((word) => word !== null);
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
      title: 'Minimum rigor',
      noWrap: true,
      render: (kind) => (kind.minimumRigor === null ? 'None' : rigorLabel(kind.minimumRigor)),
    },
    {
      accessor: 'switches',
      title: 'Switches',
      render: (kind) => (
        <Group gap={4}>
          {switchesOf(kind).map((word) => (
            <Badge key={word} size="sm" variant="light" color="gray">
              {word}
            </Badge>
          ))}
        </Group>
      ),
    },
    {
      accessor: 'addsSteps',
      title: 'Adds',
      noWrap: true,
      render: (kind) => kind.addsSteps.map(roleName).join(', '),
    },
    {
      accessor: 'overrides',
      title: 'Overrides',
      noWrap: true,
      render: (kind) => Object.keys(kind.overrides).map(roleName).join(', '),
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
    <Stack gap="xs" component="section" aria-label="Kinds">
      <Group justify="space-between" align="center">
        <Title order={4} size="md" fw={600}>
          Kinds
        </Title>
        <Button
          size="xs"
          variant="default"
          onClick={() => {
            setEditing(null);
            setAdding(true);
          }}
        >
          Add Kind
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        A kind is a sort of work with its own care: a floor under the rigor, switches for safety,
        and a stronger model for some steps.
      </Text>
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
