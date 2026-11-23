import { AreaRole, type ProjectDto } from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { ConfirmModal } from '../../shell/confirm-modal';
import { AreaDrawer } from './area-drawer';
import { SectionHeading } from './section-heading';
import { PathLines, Pill, RowActions } from './table-cells';
import { useListPatch } from './use-list-patch';

type Area = ProjectDto['areas'][number];

/** A page's kind badge with its route beside it, then Shared and Catch-All. */
function KindCell({ area }: { readonly area: Area }) {
  const none = area.role === undefined && area.catchAll !== true;
  return (
    <Group gap={4} wrap="nowrap">
      {area.role === AreaRole.Page ? (
        <>
          <Pill color="blue">Page</Pill>
          {area.route === undefined ? null : (
            <Text size="xs" ff="monospace" c="dimmed">
              {area.route}
            </Text>
          )}
        </>
      ) : null}
      {area.role === AreaRole.Shared ? <Pill color="grape">Shared</Pill> : null}
      {area.catchAll === true ? <Pill color="orange">Catch-All</Pill> : null}
      {none ? (
        <Text size="sm" c="dimmed">
          —
        </Text>
      ) : null}
    </Group>
  );
}

/** The project's areas as a table: a row opens its drawer, Add Area opens an empty one. */
export function AreasSection({ project }: { readonly project: ProjectDto }) {
  const [editing, setEditing] = useState<Area | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Area | null>(null);
  const remove = useListPatch(project);
  // Unsaved edits in the open drawer, and the row asked for while they stand.
  const [dirty, setDirty] = useState(false);
  const [switchTo, setSwitchTo] = useState<{ readonly to: Area | null } | null>(null);
  const show = (to: Area | null) => {
    setDirty(false);
    setAdding(to === null);
    setEditing(to);
  };
  const request = (to: Area | null) => {
    if (dirty && (adding || editing !== null) && editing?.name !== to?.name) setSwitchTo({ to });
    else show(to);
  };
  const open = (row: Area) => {
    request(row);
  };
  const columns: DataTableColumn<Area>[] = [
    {
      accessor: 'name',
      title: 'Name',
      noWrap: true,
      render: (area) => (
        <Text size="sm" fw={600}>
          {area.name}
        </Text>
      ),
    },
    {
      accessor: 'kind',
      title: 'Kind',
      noWrap: true,
      render: (area) => <KindCell area={area} />,
    },
    {
      accessor: 'globs',
      title: 'Paths',
      render: (area) => <PathLines paths={area.globs} />,
    },
    {
      accessor: 'actions',
      title: '',
      width: 90,
      textAlign: 'right',
      render: (area) => (
        <RowActions
          noun="area"
          name={area.name}
          {...(project.areas.length <= 1
            ? { removeBlocked: 'A project keeps at least one area' }
            : {})}
          onEdit={() => {
            open(area);
          }}
          onRemove={() => {
            remove.clear();
            setRemoving(area);
          }}
        />
      ),
    },
  ];
  return (
    <Stack gap="sm" component="section" aria-label="Areas">
      <SectionHeading
        title="Areas"
        line="The parts of the project that tasks claim."
        help={
          <>
            <Text size="sm">
              An area is a part of the project. Tasks in different areas can run at the same time,
              and a task may change only the files of the areas it names.
            </Text>
            <Text size="sm">
              Paths are folder patterns, one per line: <code>src/api/**</code> means everything
              inside src/api/.
            </Text>
          </>
        }
        action={
          <Button
            onClick={() => {
              request(null);
            }}
          >
            Add Area
          </Button>
        }
      />
      <DataTable<Area>
        aria-label="Areas"
        records={project.areas}
        columns={columns}
        idAccessor="name"
        withTableBorder
        backgroundColor="var(--tendb-color-panel)"
        borderRadius="md"
        verticalSpacing="xs"
        horizontalSpacing="md"
        highlightOnHover
        noRecordsText="No areas"
        rowStyle={() => ({ cursor: 'pointer' })}
        customRowAttributes={() => ({ 'data-keeps-drawer': '' })}
        onRowClick={({ record }) => {
          open(record);
        }}
      />
      {adding || editing !== null ? (
        <AreaDrawer
          // A new drawer per area, so one area's draft never leaks into the next.
          key={editing?.name ?? 'new'}
          project={project}
          area={editing}
          onDirty={setDirty}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      ) : null}
      <ConfirmModal
        opened={switchTo !== null}
        title="Discard Changes"
        confirmLabel="Discard"
        cancelLabel="Keep Editing"
        destructive
        onCancel={() => {
          setSwitchTo(null);
        }}
        onConfirm={() => {
          if (switchTo !== null) show(switchTo.to);
          setSwitchTo(null);
        }}
      >
        {`Discard your changes to ${editing?.name ?? 'the new area'}?`}
      </ConfirmModal>
      <ConfirmModal
        opened={removing !== null}
        title="Remove Area"
        confirmLabel="Remove Area"
        destructive
        loading={remove.saving}
        error={remove.problem}
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing === null) return;
          remove.save({ areas: project.areas.filter((a) => a.name !== removing.name) }, () => {
            setRemoving(null);
          });
        }}
      >
        {`Remove ${removing?.name ?? 'this area'}? Tasks can no longer claim its files by this name.`}
      </ConfirmModal>
    </Stack>
  );
}
