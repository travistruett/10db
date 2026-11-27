import {
  STARTER_WATCHPOINTS,
  WatchpointCoverageState,
  type Watchpoint,
  type WatchpointCoverage,
} from '@10db/contracts';
import { Alert, Box, Loader, Menu, Stack, Text } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import {
  useSetYourWatchpoints,
  useWatchpointCoverage,
  useYourWatchpoints,
} from '../../daemon/watchpoint-queries';
import { ConfirmModal } from '../../shell/confirm-modal';
import { RaisedPanel } from '../../shell/raised-panel';
import { SectionHeading } from './section-heading';
import { SplitButton } from './split-button';
import { RowActions } from './table-cells';
import { WatchpointMatches, WatchpointName } from './watchpoint-cells';
import { WatchpointDrawer } from './watchpoint-drawer';
import { refusal, useJustAdded, useWatchpointEditing } from './watchpoint-editing';
import { coverageLookup, withItem, withoutKey } from './watchpoint-lists';
import { LOUDNESS_WORDS, LoudnessControl } from './watchpoint-loudness';

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
      <Text size="sm">When It Matches decides how loud it is. {LOUDNESS_WORDS}</Text>
      <Text size="sm">
        All Projects › Watchpoints holds yours. A project can set one to Show or Ask, turn it off
        there, or add its own, without changing any other project.
      </Text>
    </>
  );
}

/** What a starter covers, as the menu says it: "Fits · 14 files", "Asks the judge · every file", or "Counting…". */
function fitLine(coverage: WatchpointCoverage): string {
  if (coverage.state === WatchpointCoverageState.Counting) return 'Counting…';
  const files =
    coverage.asks && coverage.files > 0 && coverage.files === coverage.repoFiles
      ? 'every file'
      : `${coverage.partial ? 'at least ' : ''}${String(coverage.files)} file${coverage.files === 1 ? '' : 's'}`;
  return `${coverage.asks ? 'Asks the judge' : 'Fits'} · ${files}`;
}

/** The menu's group names: for All Projects the counts are taken across the projects, otherwise in one. */
const GROUPS = {
  'All Projects': { fits: 'Fits Your Projects', none: 'Nothing in Your Projects Yet' },
  'This Project': { fits: 'Fits This Project', none: 'Nothing Here Yet' },
} as const;

/** The menu's heading and what a click does. */
function StarterHeading({ into }: { readonly into: string }) {
  return (
    <Menu.Label>
      <Text size="xs" fw={600} c="dimmed">
        Add a Starter
      </Text>
      <Text size="xs" c="dimmed" fw={400}>{`Adds it to ${into}, ready to edit`}</Text>
    </Menu.Label>
  );
}

/**
 * The library's starters not in `taken`, as menu items, or one disabled line when every one is. Each says what it
 * is for (its `why`, one line) and, with `coverage`, what it covers here. The starters that cover files come first,
 * most files first, and the rest sit under "Nothing here yet".
 */
export function LibraryItems({
  taken,
  onAdd,
  disabled,
  into,
  where,
  coverage,
}: {
  readonly taken: ReadonlySet<string>;
  readonly onAdd: (starter: Watchpoint) => void;
  /** While a save is on its way, so an add is never built from the list before it. */
  readonly disabled: boolean;
  /** Where a click puts it, in words: "your list" or "this project". */
  readonly into: string;
  /** Which scope's page the menu is on, so its groups say where the count was taken. */
  readonly where: keyof typeof GROUPS;
  /** Each starter's count where this menu is; the menu is one flat list until it is read. */
  readonly coverage?: (key: string) => WatchpointCoverage | undefined;
}) {
  const missing = STARTER_WATCHPOINTS.filter((s) => !taken.has(s.key));
  const item = (starter: Watchpoint, found: WatchpointCoverage | undefined) => (
    <Menu.Item
      key={starter.key}
      disabled={disabled}
      onClick={() => {
        onAdd(starter);
      }}
    >
      <Stack gap={0} maw={280}>
        <Text size="sm">{starter.label}</Text>
        <Text size="xs" c="dimmed" truncate title={starter.why}>
          {starter.why}
        </Text>
        {found === undefined ||
        (found.state === WatchpointCoverageState.Counted && found.files === 0) ? null : (
          <Text size="xs" c="dimmed">
            {found.state === WatchpointCoverageState.Unreadable ||
            (found.partial && found.files === 0)
              ? 'Not counted in full'
              : fitLine(found)}
          </Text>
        )}
        {found?.examples[0] === undefined ? null : (
          <Text size="xs" c="dimmed" ff="monospace" truncate>
            {found.examples[0]}
          </Text>
        )}
      </Stack>
    </Menu.Item>
  );
  if (missing.length === 0)
    return (
      <>
        <StarterHeading into={into} />
        <Menu.Item disabled>Every starter is in your list</Menu.Item>
      </>
    );
  const counts = missing.map((starter) => ({ starter, found: coverage?.(starter.key) }));
  if (coverage === undefined || counts.some((c) => c.found === undefined))
    return (
      <>
        <StarterHeading into={into} />
        {counts.map(({ starter }) => item(starter, undefined))}
      </>
    );
  const counting = (c: { found: WatchpointCoverage | undefined }) =>
    c.found?.state === WatchpointCoverageState.Counting;
  const hasFiles = (c: { found: WatchpointCoverage | undefined }) =>
    c.found?.state === WatchpointCoverageState.Counted && c.found.files > 0;
  // A count that could not be made in full is not "nothing here": it sits in Fits, after the counted ones.
  const notInFull = (c: { found: WatchpointCoverage | undefined }) =>
    c.found?.state === WatchpointCoverageState.Unreadable ||
    (c.found?.partial === true && c.found.files === 0);
  // Starters that only ask the judge a question are never ranked by count: their paths say what they ask about.
  const fits = [
    ...counts
      .filter((c) => (counting(c) || hasFiles(c)) && c.found?.asks !== true)
      .toSorted((a, b) => (b.found?.files ?? 0) - (a.found?.files ?? 0)),
    ...counts.filter((c) => notInFull(c) && c.found?.asks !== true),
  ];
  const asks = counts.filter((c) => (counting(c) || hasFiles(c)) && c.found?.asks === true);
  const none = counts.filter((c) => !fits.includes(c) && !asks.includes(c));
  return (
    <>
      <StarterHeading into={into} />
      {fits.length === 0 ? null : (
        <>
          <Menu.Label>{GROUPS[where].fits}</Menu.Label>
          {fits.map(({ starter, found }) => item(starter, found))}
        </>
      )}
      {asks.length === 0 ? null : (
        <>
          <Menu.Label>Ask the Judge</Menu.Label>
          {asks.map(({ starter, found }) => item(starter, found))}
        </>
      )}
      {none.length === 0 ? null : (
        <>
          <Menu.Label>{GROUPS[where].none}</Menu.Label>
          {none.map(({ starter, found }) => item(starter, found))}
        </>
      )}
    </>
  );
}

/** Your watchpoints, which apply in every project unless a project sets its own. */
export function AllWatchpointsSection() {
  const yours = useYourWatchpoints();
  const set = useSetYourWatchpoints();
  const countFor = coverageLookup(useWatchpointCoverage(null));
  const added = useJustAdded();
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
      render: (row) => <WatchpointMatches watchpoint={row} coverage={countFor(row.key)} />,
    },
    {
      accessor: 'loudness',
      title: 'When It Matches',
      noWrap: true,
      // Wide enough for its header at the window's 1200 px; the control itself is narrower.
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
            disabled={set.isPending}
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
              disabled={set.isPending}
              coverage={countFor}
              into="your list"
              where="All Projects"
              onAdd={(starter) => {
                void save([...list, starter], () => {
                  added.mark(starter);
                });
              }}
            />
          </SplitButton>
        }
      />
      {added.note}
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
          rowStyle={(row) => ({
            cursor: 'pointer',
            ...(row.key === added.key
              ? {
                  background: 'var(--mantine-primary-color-light-hover)',
                  boxShadow: 'inset 3px 0 0 var(--mantine-primary-color-filled)',
                }
              : {}),
          })}
          customRowAttributes={(row) => ({
            'data-keeps-drawer': '',
            'data-watchpoint-key': row.key,
          })}
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
          coverage={edit.editing === null ? undefined : countFor(edit.editing.key)}
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
