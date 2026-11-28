import type { KindDto } from '@10db/contracts';
import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { useKinds } from '../../daemon/kind-queries';
import { KindDrawer } from './kind-drawer';
import { TiebreakOrder } from './kind-tiebreak-order';
import { rigorLabel } from './rigor-labels';
import { ROLES } from './role-labels';
import { RaisedPanel } from '../../shell/raised-panel';
import { ControlSize } from '../../shell/control-size';

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

/** The Kinds tab's two page actions, which the Playbook's header holds while the tab is open. */
export interface KindsActions {
  /** The drawer is open on a new kind. */
  readonly adding: boolean;
  readonly setAdding: (adding: boolean) => void;
  /** The Tiebreak Order modal is open. */
  readonly ordering: boolean;
  readonly setOrdering: (ordering: boolean) => void;
}

/** Add Kind and Tiebreak Order, for the page header; the open drawer and modal stay the list's. */
export function useKindsActions(): KindsActions {
  const [adding, setAdding] = useState(false);
  const [ordering, setOrdering] = useState(false);
  return { adding, setAdding, ordering, setOrdering };
}

/** The Kinds tab's header controls: a quiet Tiebreak Order, then Add Kind. */
export function KindsButtons({ actions }: { readonly actions: KindsActions }) {
  return (
    <>
      <Button
        size={ControlSize.Toolbar}
        variant="default"
        onClick={() => {
          actions.setOrdering(true);
        }}
      >
        Tiebreak Order
      </Button>
      <Button
        size={ControlSize.Toolbar}
        onClick={() => {
          actions.setAdding(true);
        }}
      >
        Add Kind
      </Button>
    </>
  );
}

/**
 * The kinds of work a task can be: each with a minimum rigor, safety switches, extra steps and per-role overrides.
 * A row opens its drawer; Tiebreak Order sets which kind's override wins when a task has several.
 */
export function KindsSection({ actions }: { readonly actions: KindsActions }) {
  const kinds = useKinds();
  // The drawer edits this kind, or adds one when `adding`; closing keeps it mounted for its slide out.
  const [editing, setEditing] = useState<KindDto | null>(null);
  const { adding, setAdding, ordering, setOrdering } = actions;
  const list = kinds.data ?? [];
  const columns: DataTableColumn<KindDto>[] = [
    {
      accessor: 'label',
      title: 'Kind',
      noWrap: true,
      // The key a task carries is the drawer's to show; here the name is enough.
      render: (kind) => (
        <Text size="sm" fw={600}>
          {kind.label}
        </Text>
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
  ];
  return (
    <Stack gap="sm" component="section" aria-label="Kinds">
      {kinds.isError ? (
        <Text size="sm" c="red" role="alert">
          {kinds.error.message}
        </Text>
      ) : null}
      <RaisedPanel>
        <DataTable<KindDto>
          aria-label="Kinds"
          records={list}
          columns={columns}
          idAccessor="id"
          backgroundColor="transparent"
          verticalSpacing="xs"
          horizontalSpacing="md"
          // Too narrow a frame scrolls the table sideways instead of squeezing a column.
          styles={{ table: { minWidth: 920 } }}
          highlightOnHover
          fetching={kinds.isPending}
          noRecordsText="No kinds yet"
          rowStyle={() => ({ cursor: 'pointer' })}
          onRowClick={({ record }) => {
            setAdding(false);
            setEditing(record);
          }}
        />
      </RaisedPanel>
      <TiebreakOrder
        kinds={list}
        opened={ordering}
        onClose={() => {
          setOrdering(false);
        }}
      />
      {adding || editing !== null ? (
        <KindDrawer
          // A new drawer per kind, so one kind's draft never leaks into the next. Add Kind, in the page's
          // header, can be pressed while a kind is open, and then the new one wins.
          key={adding ? 'new' : (editing?.id ?? 'new')}
          kind={adding ? null : editing}
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
