import type { ProjectDto, ProjectWatchpointEntry, Watchpoint } from '@10db/contracts';
import { Alert, Box, Button, Group, Stack, Text } from '@mantine/core';
import { IconEye } from '@tabler/icons-react';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import {
  useProjectWatchpoints,
  useSetProjectWatchpoints,
  useWatchpointStats,
  useYourWatchpoints,
} from '../../daemon/watchpoint-queries';
import { ConfirmModal } from '../../shell/confirm-modal';
import { EmptyState } from '../../shell/empty-state';
import { usePageGuide } from '../../shell/page-guide';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { RaisedPanel } from '../../shell/raised-panel';
import { LibraryItems } from './all-watchpoints-section';
import { SettingsSectionKey } from './sections';
import { SettingsPageHeader } from './settings-page';
import { SplitButton } from './split-button';
import { Pill, RowActions } from './table-cells';
import { WatchpointMatches, WatchpointName } from './watchpoint-cells';
import { WatchpointDrawer } from './watchpoint-drawer';
import { refusal, useWatchpointEditing } from './watchpoint-editing';
import {
  choiceOf,
  isOffHere,
  isOverride,
  keysInUse,
  projectRows,
  withChoice,
  withItem,
  withoutKey,
  type ProjectRow,
} from './watchpoint-lists';
import { LoudnessControl, ProjectChoiceControl } from './watchpoint-loudness';
import { WATCHPOINTS_GUIDE, WatchpointsGuide, WhenItMatchesHelp } from './watchpoints-guide';

/** Where a save from the drawer lands, for one of yours: a copy for this project, which turns an Off one on. */
function noteFor(row: ProjectRow): string {
  return isOffHere(row)
    ? 'Saving turns it on in this project, with your changes.'
    : 'Changes apply to this project only.';
}

const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/** What applies in a project: your watchpoints as it has them, then its own. It never changes your list. */
export function WatchpointsSection({ project }: { readonly project: ProjectDto }) {
  const yours = useYourWatchpoints();
  const here = useProjectWatchpoints(project.id);
  const stats = useWatchpointStats(project.id).data;
  const set = useSetProjectWatchpoints(project.id);
  const edit = useWatchpointEditing<ProjectRow>((row) => row.shown.label);
  const [removing, setRemoving] = useState<ProjectRow | null>(null);
  const guide = usePageGuide(WATCHPOINTS_GUIDE);
  const scope = { project: project.name };
  const header = {
    sectionKey: SettingsSectionKey.Watchpoints,
    project,
  } as const;
  if (yours.data === undefined || here.data === undefined)
    return (
      <Stack gap="sm" component="section" aria-label="Watchpoints">
        <SettingsPageHeader {...header} guide={guide.opener} />
        {yours.isError || here.isError ? (
          <Alert color="red" title="Couldn't read the watchpoints">
            {(yours.error ?? here.error)?.message}
          </Alert>
        ) : (
          <PageLoading shape={PageLoadingShape.List} label="Reading the watchpoints" />
        )}
      </Stack>
    );
  const entries = here.data.entries;
  const rows = projectRows(yours.data, entries);
  const taken = keysInUse(yours.data, entries);
  const save = async (next: ProjectWatchpointEntry[], done: () => void) => {
    edit.setProblem(null);
    try {
      await set.mutateAsync(next);
      done();
    } catch (error) {
      edit.setProblem(refusal(error));
    }
  };
  const columns: DataTableColumn<ProjectRow>[] = [
    {
      accessor: 'label',
      // The paths sit under the name: a column of their own beside the four-way control would not fit the window.
      title: 'Watchpoint',
      render: (row) => (
        <Stack gap={6}>
          <WatchpointName
            watchpoint={row.shown}
            off={isOffHere(row)}
            whyLines={1}
            marks={
              row.yours === null ? (
                <Pill>This Project</Pill>
              ) : isOverride(row) ? (
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  set here
                </Text>
              ) : null
            }
          />
          <WatchpointMatches watchpoint={row.shown} shown={2} />
        </Stack>
      ),
    },
    {
      accessor: 'loudness',
      title: (
        <Group gap={4} wrap="nowrap">
          When It Matches
          <WhenItMatchesHelp guide={guide} scope={scope} />
        </Group>
      ),
      noWrap: true,
      render: (row) => (
        // A press on the control is not a press on the row.
        <Box
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          {row.yours === null ? (
            <LoudnessControl
              ariaLabel={`When ${row.shown.label} matches`}
              disabled={set.isPending}
              value={row.shown.loudness}
              onChange={(loudness) => {
                void save(withItem(entries, { ...row.shown, loudness }), () => undefined);
              }}
            />
          ) : (
            <ProjectChoiceControl
              ariaLabel={`When ${row.shown.label} matches`}
              disabled={set.isPending}
              value={choiceOf(row)}
              defaultLoudness={row.yours.loudness}
              onChange={(choice) => {
                void save(withChoice(entries, row, choice), () => undefined);
              }}
            />
          )}
        </Box>
      ),
    },
    {
      accessor: 'lastThirtyDays',
      title: 'Last 30 Days',
      // Wide enough for its header at the window's 1200 px.
      width: 112,
      render: (row) => {
        const found = stats?.find((s) => s.key === row.key);
        const color = found?.noisy === true ? 'yellow' : 'dimmed';
        return (
          <Stack gap={2} align="flex-start">
            <Text size="xs" c={color} style={{ whiteSpace: 'nowrap' }}>
              {count(found?.tasks ?? 0, 'task')}
            </Text>
            <Text size="xs" c={color} style={{ whiteSpace: 'nowrap' }}>
              {count(found?.cards ?? 0, 'card')}
            </Text>
            {found?.noisy === true ? <Pill color="yellow">Noisy</Pill> : null}
          </Stack>
        );
      },
    },
    {
      accessor: 'actions',
      title: '',
      // Edit and Remove (or its space) and the cell's padding, so neither icon is squeezed.
      width: 80,
      textAlign: 'right',
      render: (row) => (
        <RowActions
          noun="watchpoint"
          name={row.shown.label}
          onEdit={() => {
            edit.request(row);
          }}
          {...(row.yours === null
            ? {
                onRemove: () => {
                  edit.setProblem(null);
                  setRemoving(row);
                },
              }
            : {})}
        />
      ),
    },
  ];
  const opened = edit.editing;
  const saveFromDrawer = (next: Watchpoint) => {
    void save(withItem(entries, next), edit.close);
  };
  const add = () => {
    edit.request(null);
  };
  const addButton = (
    <SplitButton label="Add Watchpoint" menuLabel="More ways to add a watchpoint" onClick={add}>
      <LibraryItems
        taken={taken}
        disabled={set.isPending}
        onAdd={(starter) => {
          void save(withItem(entries, starter), () => undefined);
        }}
      />
    </SplitButton>
  );
  return (
    <Stack gap="sm" component="section" aria-label="Watchpoints">
      {/* While nothing applies, the empty state holds the add and the guide; the header holds them after. */}
      <SettingsPageHeader
        {...header}
        {...(rows.length === 0 ? {} : { guide: guide.opener, actions: addButton })}
      />
      {rows.length === 0 ? (
        <EmptyState
          icon={IconEye}
          title="Nothing watched yet"
          extra={
            <>
              {addButton}
              <Button variant="default" onClick={guide.opener.onOpen}>
                {WATCHPOINTS_GUIDE}
              </Button>
            </>
          }
        >
          Name the files you want to judge yourself, and 10db shows you every change to them.
        </EmptyState>
      ) : (
        <RaisedPanel>
          <DataTable<ProjectRow>
            aria-label="Watchpoints"
            records={rows}
            columns={columns}
            idAccessor="key"
            backgroundColor="transparent"
            verticalSpacing="xs"
            horizontalSpacing="xs"
            highlightOnHover
            noRecordsText="No watchpoints apply here"
            rowStyle={() => ({ cursor: 'pointer' })}
            customRowAttributes={() => ({ 'data-keeps-drawer': '' })}
            onRowClick={({ record }) => {
              edit.request(record);
            }}
          />
        </RaisedPanel>
      )}
      {edit.problem !== null && !edit.opened && removing === null ? (
        <Alert color="red" title="Couldn't save the watchpoint">
          {edit.problem}
        </Alert>
      ) : null}
      {edit.opened ? (
        <WatchpointDrawer
          key={opened?.key ?? 'new'}
          watchpoint={opened?.shown ?? null}
          takenKeys={taken}
          saving={set.isPending}
          problem={edit.problem}
          onDirty={edit.setDirty}
          onSave={saveFromDrawer}
          onClose={edit.close}
          {...(opened?.yours ? { note: noteFor(opened) } : {})}
          {...(opened !== null && isOverride(opened)
            ? {
                onUseDefault: () => {
                  void save(withoutKey(entries, opened.key), edit.close);
                },
              }
            : {})}
        />
      ) : null}
      {edit.discardModal}
      <ConfirmModal
        opened={removing !== null}
        title="Remove Watchpoint"
        confirmLabel="Remove Watchpoint"
        destructive
        loading={set.isPending}
        error={edit.problem}
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing === null) return;
          void save(withoutKey(entries, removing.key), () => {
            setRemoving(null);
          });
        }}
      >
        {`Remove ${removing?.shown.label ?? 'this watchpoint'} from this project?`}
      </ConfirmModal>
      <WatchpointsGuide
        guide={guide}
        scope={scope}
        {...(rows.length === 0 ? { onAdd: add } : {})}
      />
    </Stack>
  );
}
