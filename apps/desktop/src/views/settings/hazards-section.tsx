import { hazardScope, HazardScope, type ProjectDto } from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { useLookAgainAtHazards } from '../../daemon/hazard-queries';
import { ConfirmModal } from '../../shell/confirm-modal';
import { FoundByTendb, HazardLookStatus } from './hazard-additions';
import { HazardDrawer } from './hazard-drawer';
import { SectionHeading } from './section-heading';
import { Pill, RowActions } from './table-cells';
import { useListPatch } from './use-list-patch';

type Hazard = ProjectDto['hazards'][number];

const count = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** "70 commands · 22 paths": what a hazard covers, in brief; its drawer lists them. */
function coverage(hazard: Hazard): string {
  return [
    count(hazard.commands.length, 'command', 'commands'),
    count(hazard.globs.length, 'path', 'paths'),
  ].join(' · ');
}

/** The project's hazards as a table of names and what each covers, with what 10db found by itself under it. */
export function HazardsSection({ project }: { readonly project: ProjectDto }) {
  const [editing, setEditing] = useState<Hazard | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Hazard | null>(null);
  const remove = useListPatch(project);
  const look = useLookAgainAtHazards(project.id);
  // Unsaved edits in the open drawer, and the row asked for while they stand.
  const [dirty, setDirty] = useState(false);
  const [switchTo, setSwitchTo] = useState<{ readonly to: Hazard | null } | null>(null);
  const show = (to: Hazard | null) => {
    setDirty(false);
    setAdding(to === null);
    setEditing(to);
  };
  const request = (to: Hazard | null) => {
    const drawerOpen = adding || editing !== null;
    // The open row again changes nothing, and keeps its edits.
    if (drawerOpen && editing?.name === to?.name) return;
    if (dirty && drawerOpen) setSwitchTo({ to });
    else show(to);
  };
  const open = (row: Hazard) => {
    request(row);
  };
  const columns: DataTableColumn<Hazard>[] = [
    {
      accessor: 'name',
      title: 'Name',
      noWrap: true,
      render: (hazard) => (
        <Text size="sm" fw={600}>
          {hazard.name}
        </Text>
      ),
    },
    {
      accessor: 'scope',
      title: 'Scope',
      noWrap: true,
      render: (hazard) =>
        hazardScope(hazard) === HazardScope.Copy ? (
          <Pill color="teal">Per Copy</Pill>
        ) : (
          <Pill>Project</Pill>
        ),
    },
    {
      accessor: 'covers',
      title: 'Covers',
      noWrap: true,
      render: (hazard) => (
        <Text size="sm" c="dimmed">
          {coverage(hazard)}
        </Text>
      ),
    },
    {
      accessor: 'actions',
      title: '',
      width: 90,
      textAlign: 'right',
      render: (hazard) => (
        <RowActions
          noun="hazard"
          name={hazard.name}
          onEdit={() => {
            open(hazard);
          }}
          onRemove={() => {
            remove.clear();
            setRemoving(hazard);
          }}
        />
      ),
    },
  ];
  return (
    <Stack gap="sm" component="section" aria-label="Hazards">
      <SectionHeading
        title="Hazards"
        line="Files and commands that tasks take turns on."
        help="A hazard is a set of files only one task changes at a time, such as lockfiles or migrations. A task that touches one, or runs one of its commands, waits for the task that holds it. 10db reads the project's files (its Makefiles, compose files, package scripts, AGENTS.md and docs) to find the commands that change lockfiles and migrations, and adds them by itself; you are asked only before one is taken out."
        action={
          <Group gap="xs" wrap="nowrap">
            <Button
              data-keeps-drawer
              variant="subtle"
              color="gray"
              loading={look.isPending}
              onClick={() => {
                look.mutate();
              }}
            >
              Look Again
            </Button>
            <Button
              data-keeps-drawer
              onClick={() => {
                request(null);
              }}
            >
              Add Hazard
            </Button>
          </Group>
        }
      />
      <HazardLookStatus project={project} look={look} />
      <DataTable<Hazard>
        aria-label="Hazards"
        records={project.hazards}
        columns={columns}
        idAccessor="name"
        withTableBorder
        backgroundColor="var(--tendb-color-panel)"
        borderRadius="md"
        verticalSpacing="xs"
        horizontalSpacing="md"
        highlightOnHover
        noRecordsText="No hazards"
        rowStyle={() => ({ cursor: 'pointer' })}
        customRowAttributes={() => ({ 'data-keeps-drawer': '' })}
        onRowClick={({ record }) => {
          open(record);
        }}
      />
      <FoundByTendb project={project} />
      {adding || editing !== null ? (
        <HazardDrawer
          key={editing?.name ?? 'new'}
          project={project}
          hazard={editing}
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
        {`Discard your changes to ${editing?.name ?? 'the new hazard'}?`}
      </ConfirmModal>
      <ConfirmModal
        opened={removing !== null}
        title="Remove Hazard"
        confirmLabel="Remove Hazard"
        destructive
        loading={remove.saving}
        error={remove.problem}
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing === null) return;
          remove.save({ hazards: project.hazards.filter((h) => h.name !== removing.name) }, () => {
            setRemoving(null);
          });
        }}
      >
        {`Remove ${removing?.name ?? 'this hazard'}? Tasks no longer take turns on its files and commands.`}
      </ConfirmModal>
    </Stack>
  );
}
