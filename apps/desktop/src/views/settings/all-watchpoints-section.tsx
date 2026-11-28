import {
  STARTER_WATCHPOINTS,
  WatchpointCoverageState,
  type Watchpoint,
  type WatchpointCoverage,
} from '@10db/contracts';
import { Alert, Box, Button, Group, Menu, Stack, Text } from '@mantine/core';
import { IconEye } from '@tabler/icons-react';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import {
  useSetYourWatchpoints,
  useWatchpointCoverage,
  useYourWatchpoints,
} from '../../daemon/watchpoint-queries';
import { ConfirmModal } from '../../shell/confirm-modal';
import { EmptyState } from '../../shell/empty-state';
import { usePageGuide } from '../../shell/page-guide';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { RaisedPanel } from '../../shell/raised-panel';
import { SettingsSectionKey } from './sections';
import { SettingsPageHeader } from './settings-page';
import { SplitButton, SplitButtonLoading } from './split-button';
import { RowActions } from './table-cells';
import { WatchpointMatches, WatchpointName } from './watchpoint-cells';
import { WatchpointDrawer } from './watchpoint-drawer';
import { refusal, useJustAdded, useWatchpointEditing } from './watchpoint-editing';
import { coverageLookup, withItem, withoutKey } from './watchpoint-lists';
import { LoudnessControl } from './watchpoint-loudness';
import { WATCHPOINTS_GUIDE, WatchpointsGuide, WhenItMatchesHelp } from './watchpoints-guide';

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

/** The table's column titles and widths, which its placeholder draws too while the list is read. */
const WATCHPOINT_COLUMNS = {
  label: { title: 'Watchpoint' },
  globs: { title: 'Matches' },
  // Wide enough for its header and its info button at the window's 1200 px; the control itself is narrower.
  loudness: { title: 'When It Matches', width: 184 },
  actions: { title: '', width: 90 },
} as const;

/** Your watchpoints, which apply in every project unless a project sets its own. */
export function AllWatchpointsSection() {
  const yours = useYourWatchpoints();
  const set = useSetYourWatchpoints();
  const countFor = coverageLookup(useWatchpointCoverage(null));
  const added = useJustAdded();
  const edit = useWatchpointEditing<Watchpoint>((w) => w.label);
  const [removing, setRemoving] = useState<Watchpoint | null>(null);
  const guide = usePageGuide(WATCHPOINTS_GUIDE);
  if (yours.data === undefined)
    return (
      <Stack gap="sm" component="section" aria-label="Watchpoints">
        <SettingsPageHeader
          sectionKey={SettingsSectionKey.AllWatchpoints}
          guide={guide.opener}
          actions={
            <SplitButtonLoading label="Add Watchpoint" menuLabel="More ways to add a watchpoint" />
          }
        />
        {yours.isError ? (
          <Alert color="red" title="Couldn't read the watchpoints">
            {yours.error.message}
          </Alert>
        ) : (
          <>
            <PageLoading
              shape={PageLoadingShape.Table}
              label="Reading the watchpoints"
              columns={Object.values(WATCHPOINT_COLUMNS)}
              rows={4}
              cellLines={3}
              verticalSpacing="xs"
              horizontalSpacing="md"
            />
          </>
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
      ...WATCHPOINT_COLUMNS.label,
      render: (row) => <WatchpointName watchpoint={row} />,
    },
    {
      accessor: 'globs',
      ...WATCHPOINT_COLUMNS.globs,
      render: (row) => <WatchpointMatches watchpoint={row} coverage={countFor(row.key)} />,
    },
    {
      accessor: 'loudness',
      ...WATCHPOINT_COLUMNS.loudness,
      title: (
        <Group gap={4} wrap="nowrap">
          {WATCHPOINT_COLUMNS.loudness.title}
          <WhenItMatchesHelp guide={guide} scope={null} />
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
      ...WATCHPOINT_COLUMNS.actions,
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
  const add = () => {
    edit.request(null);
  };
  const addButton = (
    <SplitButton label="Add Watchpoint" menuLabel="More ways to add a watchpoint" onClick={add}>
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
  );
  return (
    <Stack gap="sm" component="section" aria-label="Watchpoints">
      {/* While the list is empty, the empty state holds the add and the guide; the header holds them after. */}
      <SettingsPageHeader
        sectionKey={SettingsSectionKey.AllWatchpoints}
        {...(list.length === 0 ? {} : { guide: guide.opener, actions: addButton })}
      />
      {list.length === 0 ? (
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
        <>
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
        </>
      )}
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
      <WatchpointsGuide guide={guide} scope={null} {...(list.length === 0 ? { onAdd: add } : {})} />
    </Stack>
  );
}
