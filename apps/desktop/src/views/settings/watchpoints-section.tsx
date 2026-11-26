import type { ProjectDto, ProjectWatchpointEntry, Watchpoint } from '@10db/contracts';
import { Alert, Box, Loader, Stack, Text } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import {
  useProjectWatchpoints,
  useSetProjectWatchpoints,
  useWatchpointStats,
  useYourWatchpoints,
} from '../../daemon/watchpoint-queries';
import { ConfirmModal } from '../../shell/confirm-modal';
import { RaisedPanel } from '../../shell/raised-panel';
import { LibraryItems, WATCHPOINTS_LINE, WatchpointsHelp } from './all-watchpoints-section';
import { SectionHeading } from './section-heading';
import { SplitButton } from './split-button';
import { Pill, RowActions } from './table-cells';
import { WatchpointMatches, WatchpointName } from './watchpoint-cells';
import { WatchpointDrawer } from './watchpoint-drawer';
import { refusal, useWatchpointEditing } from './watchpoint-editing';
import {
  choiceOf,
  isOffHere,
  isOverride,
  projectRows,
  withChoice,
  withItem,
  withoutKey,
  type ProjectRow,
} from './watchpoint-lists';
import { LoudnessControl, ProjectChoiceControl } from './watchpoint-loudness';

const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/** What applies in a project: your watchpoints as it has them, then its own. It never changes your list. */
export function WatchpointsSection({ project }: { readonly project: ProjectDto }) {
  const yours = useYourWatchpoints();
  const here = useProjectWatchpoints(project.id);
  const stats = useWatchpointStats(project.id).data;
  const set = useSetProjectWatchpoints(project.id);
  const edit = useWatchpointEditing<ProjectRow>((row) => row.shown.label);
  const [removing, setRemoving] = useState<ProjectRow | null>(null);
  if (yours.data === undefined || here.data === undefined)
    return (
      <Stack gap="sm" component="section" aria-label="Watchpoints">
        {yours.isError || here.isError ? (
          <Alert color="red" title="Couldn't read the watchpoints">
            {(yours.error ?? here.error)?.message}
          </Alert>
        ) : (
          <Loader size="sm" aria-label="Reading the watchpoints" />
        )}
      </Stack>
    );
  const entries = here.data.entries;
  const rows = projectRows(yours.data, entries);
  const taken = new Set([...yours.data.map((w) => w.key), ...entries.map((e) => e.key)]);
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
          <WatchpointMatches watchpoint={row.shown} />
        </Stack>
      ),
    },
    {
      accessor: 'loudness',
      title: 'When It Matches',
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
              value={row.shown.loudness}
              onChange={(loudness) => {
                void save(withItem(entries, { ...row.shown, loudness }), () => undefined);
              }}
            />
          ) : (
            <ProjectChoiceControl
              ariaLabel={`When ${row.shown.label} matches`}
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
      width: 96,
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
      width: 72,
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
  return (
    <Stack gap="sm" component="section" aria-label="Watchpoints">
      <SectionHeading
        title="Watchpoints"
        line={WATCHPOINTS_LINE}
        help={<WatchpointsHelp />}
        action={
          <SplitButton
            label="Add Watchpoint"
            menuLabel="More ways to add a watchpoint"
            onClick={() => {
              edit.request(null);
            }}
          >
            <LibraryItems
              taken={taken}
              onAdd={(starter) => {
                void save([...entries, starter], () => undefined);
              }}
            />
          </SplitButton>
        }
      />
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
          {...((opened?.yours ?? null) === null
            ? {}
            : { note: 'Changes apply to this project only.' })}
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
    </Stack>
  );
}
