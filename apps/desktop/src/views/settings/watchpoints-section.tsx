import {
  STARTER_WATCHPOINTS,
  type EffectiveWatchpoint,
  type ProjectDto,
  type WatchpointLoudness,
} from '@10db/contracts';
import { Alert, Anchor, Box, Button, Group, Loader, Menu, Stack, Text } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import {
  useProjectWatchpoints,
  useSetProjectWatchpoints,
  useSetYourWatchpoints,
  useWatchpointStats,
  useYourWatchpoints,
} from '../../daemon/watchpoint-queries';
import { ConfirmModal } from '../../shell/confirm-modal';
import { RaisedPanel } from '../../shell/raised-panel';
import { SectionHeading } from './section-heading';
import { Pill, RowActions } from './table-cells';
import { WatchpointDrawer } from './watchpoint-drawer';
import {
  offEntries,
  removed,
  turnedOff,
  withLoudness,
  type WatchpointLists,
} from './watchpoint-lists';
import { LoudnessControl } from './watchpoint-loudness';

const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/** Paths a row lists before "+N more"; the drawer has the rest. */
const SHOWN_GLOBS = 3;
const YOURS = 'Yours, in every project';
const THIS_PROJECT = 'This project';

/** The watchpoints that apply in a project: the builder's, then its own, each with a one-click loudness. */
export function WatchpointsSection({ project }: { readonly project: ProjectDto }) {
  const yours = useYourWatchpoints();
  const here = useProjectWatchpoints(project.id);
  const stats = useWatchpointStats(project.id).data;
  const setYours = useSetYourWatchpoints();
  const setHere = useSetProjectWatchpoints(project.id);
  const [editing, setEditing] = useState<EffectiveWatchpoint | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<EffectiveWatchpoint | null>(null);
  const [dirty, setDirty] = useState(false);
  const [switchTo, setSwitchTo] = useState<{ readonly to: EffectiveWatchpoint | null } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
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
  const lists: WatchpointLists = { yours: yours.data, entries: here.data.entries };
  const rows = here.data.effective;
  const missing = STARTER_WATCHPOINTS.filter((s) => !lists.yours.some((w) => w.key === s.key));
  const saving = setYours.isPending || setHere.isPending;
  /** Sends each list that changed; the builder's first, so a project entry never names a key that is not there yet. */
  const save = async (next: WatchpointLists, done: () => void) => {
    setProblem(null);
    try {
      if (JSON.stringify(next.yours) !== JSON.stringify(lists.yours))
        await setYours.mutateAsync([...next.yours]);
      if (JSON.stringify(next.entries) !== JSON.stringify(lists.entries))
        await setHere.mutateAsync([...next.entries]);
      done();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The daemon refused the change.');
    }
  };
  const show = (to: EffectiveWatchpoint | null) => {
    setDirty(false);
    setProblem(null);
    setAdding(to === null);
    setEditing(to);
  };
  const request = (to: EffectiveWatchpoint | null) => {
    const drawerOpen = adding || editing !== null;
    if (drawerOpen && editing?.key === to?.key) return;
    if (dirty && drawerOpen) setSwitchTo({ to });
    else show(to);
  };
  const setLoudness = (row: EffectiveWatchpoint, loudness: WatchpointLoudness) => {
    void save(withLoudness(lists, row, loudness), () => undefined);
  };
  const columns: DataTableColumn<EffectiveWatchpoint>[] = [
    {
      accessor: 'label',
      title: 'Watchpoint',
      width: 320,
      render: (row) => (
        <Stack gap={2}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600}>
              {row.label}
            </Text>
            {row.from === 'override' ? <Pill color="cyan">Overrides yours</Pill> : null}
          </Group>
          {row.why === '' ? null : (
            <Text size="xs" c="dimmed">
              {row.why}
            </Text>
          )}
          {row.from === 'override' ? (
            <Anchor
              component="button"
              type="button"
              size="xs"
              ta="left"
              aria-label={`Use yours for ${row.label}`}
              onClick={(e) => {
                e.stopPropagation();
                void save(removed(lists, row), () => undefined);
              }}
            >
              Use yours
            </Anchor>
          ) : null}
        </Stack>
      ),
    },
    {
      accessor: 'globs',
      title: 'Matches',
      render: (row) => (
        <Stack gap={0}>
          {row.globs.slice(0, SHOWN_GLOBS).map((glob) => (
            <Text key={glob} size="xs" ff="monospace" c="dimmed">
              {glob}
            </Text>
          ))}
          {row.globs.length > SHOWN_GLOBS ? (
            <Text size="xs" c="dimmed">
              {`+${String(row.globs.length - SHOWN_GLOBS)} more`}
            </Text>
          ) : null}
          {row.lines.length > 0 ? (
            <Text size="xs" c="dimmed">
              {`+ ${String(row.lines.length)} line pattern${row.lines.length === 1 ? '' : 's'}`}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      accessor: 'loudness',
      title: 'Loudness',
      noWrap: true,
      width: 210,
      render: (row) => (
        // A press on the control is not a press on the row.
        <Box
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <LoudnessControl
            ariaLabel={`Loudness of ${row.label}`}
            value={row.loudness}
            onChange={(loudness) => {
              setLoudness(row, loudness);
            }}
          />
        </Box>
      ),
    },
    {
      accessor: 'lastThirtyDays',
      title: 'Last 30 days',
      noWrap: true,
      render: (row) => {
        const found = stats?.find((s) => s.key === row.key);
        const line = `${count(found?.tasks ?? 0, 'task')} · ${count(found?.cards ?? 0, 'card')}`;
        return (
          <Group gap={6} wrap="nowrap">
            <Text size="sm" c={found?.noisy === true ? 'yellow' : 'dimmed'}>
              {line}
            </Text>
            {found?.noisy === true ? <Pill color="yellow">noisy</Pill> : null}
          </Group>
        );
      },
    },
    {
      accessor: 'actions',
      title: '',
      width: 90,
      textAlign: 'right',
      render: (row) => (
        <RowActions
          noun="watchpoint"
          name={row.label}
          onEdit={() => {
            request(row);
          }}
          onRemove={() => {
            setProblem(null);
            setRemoving(row);
          }}
        />
      ),
    },
  ];
  const groups = [
    { id: YOURS, rows: rows.filter((r) => r.from === 'you') },
    { id: THIS_PROJECT, rows: rows.filter((r) => r.from !== 'you') },
  ];
  const off = offEntries(lists.entries, lists.yours);
  return (
    <Stack gap="sm" component="section" aria-label="Watchpoints">
      <SectionHeading
        title="Watchpoints"
        line="The kinds of change you want to judge yourself. A task whose changes touch one shows you just those changes, with the agent's reason and the reviewer's check."
        action={
          <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
            <Menu position="bottom-end">
              <Menu.Target>
                <Button
                  variant="default"
                  rightSection={<IconChevronDown size={14} aria-hidden />}
                  style={{ flexShrink: 0 }}
                >
                  Add from Library
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {missing.length === 0 ? (
                  <Menu.Item disabled>All starters are in your list</Menu.Item>
                ) : (
                  missing.map((starter) => (
                    <Menu.Item
                      key={starter.key}
                      onClick={() => {
                        void save(
                          { yours: [...lists.yours, starter], entries: lists.entries },
                          () => undefined,
                        );
                      }}
                    >
                      {starter.label}
                    </Menu.Item>
                  ))
                )}
              </Menu.Dropdown>
            </Menu>
            <Button
              style={{ flexShrink: 0 }}
              onClick={() => {
                request(null);
              }}
            >
              New Watchpoint
            </Button>
          </Group>
        }
      />
      {groups.map((group, index) => (
        <Stack key={group.id} gap={4}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase">
            {group.id}
          </Text>
          <RaisedPanel>
            <DataTable<EffectiveWatchpoint>
              aria-label={group.id}
              records={group.rows}
              columns={columns}
              idAccessor="key"
              noHeader={index > 0}
              backgroundColor="transparent"
              verticalSpacing="xs"
              horizontalSpacing="md"
              highlightOnHover
              noRecordsText={
                group.id === YOURS ? 'No watchpoints of yours' : 'This project has none of its own'
              }
              rowStyle={() => ({ cursor: 'pointer' })}
              customRowAttributes={() => ({ 'data-keeps-drawer': '' })}
              onRowClick={({ record }) => {
                request(record);
              }}
            />
          </RaisedPanel>
        </Stack>
      ))}
      {off.length > 0 ? (
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            Off in this project
          </Text>
          {off.map((entry) => (
            <Group key={entry.key} gap="xs">
              <Text size="sm">{entry.label}</Text>
              <Anchor
                component="button"
                type="button"
                size="xs"
                aria-label={`Turn ${entry.label} back on`}
                onClick={() => {
                  void save(turnedOff(lists, entry.key, false), () => undefined);
                }}
              >
                Turn back on
              </Anchor>
            </Group>
          ))}
        </Stack>
      ) : null}
      {problem !== null && !adding && editing === null ? (
        <Alert color="red" title="Couldn't save the watchpoint">
          {problem}
        </Alert>
      ) : null}
      {adding || editing !== null ? (
        <WatchpointDrawer
          key={editing?.key ?? 'new'}
          row={editing}
          lists={lists}
          saving={saving}
          problem={problem}
          onDirty={setDirty}
          onSave={(next) => {
            void save(next, () => {
              setAdding(false);
              setEditing(null);
            });
          }}
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
        {`Discard your changes to ${editing?.label ?? 'the new watchpoint'}?`}
      </ConfirmModal>
      <ConfirmModal
        opened={removing !== null}
        title="Remove Watchpoint"
        confirmLabel="Remove Watchpoint"
        destructive
        loading={saving}
        error={problem}
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing === null) return;
          void save(removed(lists, removing), () => {
            setRemoving(null);
          });
        }}
      >
        {removing?.from === 'you'
          ? `Remove ${removing.label} from every project? Tasks stop showing you its changes.`
          : `Remove ${removing?.label ?? 'this watchpoint'} from this project?`}
      </ConfirmModal>
    </Stack>
  );
}
