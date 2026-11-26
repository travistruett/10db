import { STARTER_WATCHPOINTS, type Watchpoint } from '@10db/contracts';
import { Alert, Box, Loader, Menu, Stack, Text } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { useSetYourWatchpoints, useYourWatchpoints } from '../../daemon/watchpoint-queries';
import { ConfirmModal } from '../../shell/confirm-modal';
import { RaisedPanel } from '../../shell/raised-panel';
import { SectionHeading } from './section-heading';
import { SplitButton } from './split-button';
import { RowActions } from './table-cells';
import { WatchpointMatches, WatchpointName } from './watchpoint-cells';
import { WatchpointDrawer } from './watchpoint-drawer';
import { refusal, useWatchpointEditing } from './watchpoint-editing';
import { withItem, withoutKey } from './watchpoint-lists';
import { LoudnessControl } from './watchpoint-loudness';

export const WATCHPOINTS_LINE = 'Changes you want to judge yourself.';

/** The long text behind both pages' info button. */
export function WatchpointsHelp() {
  return (
    <>
      <Text size="sm">
        A watchpoint names files whose changes you want to see. A task whose changes touch one shows
        you just those changes in its For You, with the agent&apos;s reason and the reviewer&apos;s
        check.
      </Text>
      <Text size="sm">
        When It Matches decides how loud it is: Show puts the changes in For You and the pull
        request; Ask also leaves one Inbox card per task.
      </Text>
      <Text size="sm">
        All Projects › Watchpoints holds yours. A project can set one to Show or Ask, turn it off
        there, or add its own, without changing any other project.
      </Text>
    </>
  );
}

/** The library's starters not in `taken`, as menu items, or one disabled line when every one is. */
export function LibraryItems({
  taken,
  onAdd,
}: {
  readonly taken: ReadonlySet<string>;
  readonly onAdd: (starter: Watchpoint) => void;
}) {
  const missing = STARTER_WATCHPOINTS.filter((s) => !taken.has(s.key));
  return (
    <>
      <Menu.Label>From the Library</Menu.Label>
      {missing.length === 0 ? (
        <Menu.Item disabled>Every starter is in your list</Menu.Item>
      ) : (
        missing.map((starter) => (
          <Menu.Item
            key={starter.key}
            onClick={() => {
              onAdd(starter);
            }}
          >
            {starter.label}
          </Menu.Item>
        ))
      )}
    </>
  );
}

/** Your watchpoints, which apply in every project unless a project sets its own. */
export function AllWatchpointsSection() {
  const yours = useYourWatchpoints();
  const set = useSetYourWatchpoints();
  const edit = useWatchpointEditing<Watchpoint>((w) => w.label);
  const [removing, setRemoving] = useState<Watchpoint | null>(null);
  if (yours.data === undefined)
    return (
      <Stack gap="sm" component="section" aria-label="Watchpoints">
        {yours.isError ? (
          <Alert color="red" title="Couldn't read the watchpoints">
            {yours.error.message}
          </Alert>
        ) : (
          <Loader size="sm" aria-label="Reading the watchpoints" />
        )}
      </Stack>
    );
  const list = yours.data;
  const save = async (next: Watchpoint[], done: () => void) => {
    edit.setProblem(null);
    try {
      await set.mutateAsync(next);
      done();
    } catch (error) {
      edit.setProblem(refusal(error));
    }
  };
  const columns: DataTableColumn<Watchpoint>[] = [
    {
      accessor: 'label',
      title: 'Watchpoint',
      render: (row) => <WatchpointName watchpoint={row} />,
    },
    {
      accessor: 'globs',
      title: 'Matches',
      render: (row) => <WatchpointMatches watchpoint={row} />,
    },
    {
      accessor: 'loudness',
      title: 'When It Matches',
      noWrap: true,
      width: 160,
      render: (row) => (
        // A press on the control is not a press on the row.
        <Box
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <LoudnessControl
            ariaLabel={`When ${row.label} matches`}
            value={row.loudness}
            onChange={(loudness) => {
              void save(withItem(list, { ...row, loudness }), () => undefined);
            }}
          />
        </Box>
      ),
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
            edit.request(row);
          }}
          onRemove={() => {
            edit.setProblem(null);
            setRemoving(row);
          }}
        />
      ),
    },
  ];
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
              taken={new Set(list.map((w) => w.key))}
              onAdd={(starter) => {
                void save([...list, starter], () => undefined);
              }}
            />
          </SplitButton>
        }
      />
      <RaisedPanel>
        <DataTable<Watchpoint>
          aria-label="Watchpoints"
          records={list}
          columns={columns}
          idAccessor="key"
          backgroundColor="transparent"
          verticalSpacing="xs"
          horizontalSpacing="md"
          highlightOnHover
          noRecordsText="No watchpoints yet"
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
          key={edit.editing?.key ?? 'new'}
          watchpoint={edit.editing}
          takenKeys={new Set(list.map((w) => w.key))}
          saving={set.isPending}
          problem={edit.problem}
          onDirty={edit.setDirty}
          onSave={(next) => {
            void save(withItem(list, next), edit.close);
          }}
          onClose={edit.close}
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
          void save(withoutKey(list, removing.key), () => {
            setRemoving(null);
          });
        }}
      >
        {`Remove ${removing?.label ?? 'this watchpoint'} from every project? Tasks stop showing you its changes.`}
      </ConfirmModal>
    </Stack>
  );
}
