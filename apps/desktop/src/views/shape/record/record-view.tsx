import type { PlanRecordDto, ShapeId } from '@10db/contracts';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import { IconMessages } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import { usePlanRecord } from '../../../daemon/plan-record-queries';
import { DecisionsTab } from './decisions-tab';
import { DocumentsTab } from './documents-tab';
import { EvidenceTab } from './evidence-tab';
import { ExportButton } from './export-button';
import { QuestionsTab } from './questions-tab';
import { RECORD_TABS, RecordTab, type RecordSearch } from './record-tabs';
import { ReviewsTab } from './reviews-tab';
import { TasksTab } from './tasks-tab';

// A Plan's record, beside its conversation: the documents an effort wrote, what it decided, the
// evidence it read, its reviews, what it left open and the tasks made from it.

const ORIGIN_LABELS: Readonly<Record<NonNullable<PlanRecordDto['origin']>['kind'], string>> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  other: 'another tool',
};

/** "Imported 12 Nov 2026 from Claude Code"; null for a Plan made in its conversation. */
export function importedLine(record: PlanRecordDto): string | null {
  if (record.importedAt === null) return null;
  const from = record.origin === null ? '' : ` from ${ORIGIN_LABELS[record.origin.kind]}`;
  return `Imported ${dayjs(record.importedAt).format('D MMM YYYY')}${from}`;
}

const TAB_VALUES: readonly string[] = Object.values(RecordTab);
const isRecordTab = (value: string | null): value is RecordTab =>
  value !== null && TAB_VALUES.includes(value);

function TabCount({ count, label }: { readonly count: number; readonly label: string }) {
  if (count === 0) return null;
  return (
    <Badge size="sm" variant="light" color="gray" circle={count < 10}>
      <span aria-hidden="true">{count}</span>
      <VisuallyHidden>{`${String(count)} ${label.toLowerCase()}`}</VisuallyHidden>
    </Badge>
  );
}

function panelOf(
  tab: RecordTab,
  props: {
    readonly shapeId: ShapeId;
    readonly record: PlanRecordDto;
    readonly search: RecordSearch;
    readonly onSearch: (next: RecordSearch) => void;
  },
): ReactNode {
  switch (tab) {
    case RecordTab.Documents:
      return <DocumentsTab {...props} />;
    case RecordTab.Decisions:
      return <DecisionsTab shapeId={props.shapeId} />;
    case RecordTab.Evidence:
      return <EvidenceTab shapeId={props.shapeId} />;
    case RecordTab.Reviews:
      return (
        <ReviewsTab shapeId={props.shapeId} documents={props.record.documents.map((d) => d.key)} />
      );
    case RecordTab.Questions:
      return <QuestionsTab shapeId={props.shapeId} />;
    case RecordTab.Tasks:
      return (
        <TasksTab
          shapeId={props.shapeId}
          projectId={props.record.projectId}
          onSearch={props.onSearch}
        />
      );
  }
}

function RecordTabs({
  shapeId,
  record,
  tab,
  search,
  onSearch,
}: {
  readonly shapeId: ShapeId;
  readonly record: PlanRecordDto;
  readonly tab: RecordTab;
  readonly search: RecordSearch;
  readonly onSearch: (next: RecordSearch) => void;
}) {
  return (
    <Tabs
      value={tab}
      onChange={(next) => {
        if (isRecordTab(next)) onSearch({ tab: next });
      }}
      keepMounted={false}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Tabs.List>
        {RECORD_TABS.map((t) => (
          <Tabs.Tab
            key={t.tab}
            value={t.tab}
            rightSection={<TabCount count={t.count(record)} label={t.label} />}
          >
            {t.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {RECORD_TABS.map((t) => (
        <Tabs.Panel
          key={t.tab}
          value={t.tab}
          pt="md"
          // Documents scrolls its outline and its body apart; a table tab scrolls as a whole.
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflowY: t.tab === RecordTab.Documents ? 'hidden' : 'auto',
          }}
        >
          {panelOf(t.tab, { shapeId, record, search, onSearch })}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

export function RecordView({
  shapeId,
  search,
  onSearch,
}: {
  readonly shapeId: ShapeId;
  readonly search: RecordSearch;
  readonly onSearch: (next: RecordSearch) => void;
}) {
  const record = usePlanRecord(shapeId);
  const navigate = useNavigate();
  const tab = search.tab ?? RecordTab.Documents;
  return (
    <Stack
      component="section"
      aria-label="Record"
      gap="sm"
      p="md"
      // A flex item of the shell's main column, as Plan's split pane is, so its height is the window's.
      style={{ flex: '1 1 0px', minHeight: 420 }}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={2} miw={0}>
          <Group gap="sm" wrap="nowrap" miw={0}>
            <Title order={2} size="h4">
              Record
            </Title>
            <Text size="sm" fw={500} lineClamp={1}>
              {record.data?.title}
            </Text>
          </Group>
          {record.data === undefined ? null : (
            <Text size="xs" c="dimmed">
              {importedLine(record.data)}
            </Text>
          )}
        </Stack>
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Button
            variant="default"
            size="xs"
            leftSection={<IconMessages size={14} stroke={1.5} />}
            onClick={() => {
              void navigate({ to: '/shape/$shapeId', params: { shapeId } });
            }}
          >
            Conversation
          </Button>
          <ExportButton shapeId={shapeId} />
        </Group>
      </Group>
      {record.isError ? (
        <Alert color="red" title="Couldn't load the record">
          {record.error.message}
        </Alert>
      ) : record.data === undefined ? (
        <Loader size="sm" aria-label="Loading the record" />
      ) : (
        <RecordTabs
          shapeId={shapeId}
          record={record.data}
          tab={tab}
          search={search}
          onSearch={onSearch}
        />
      )}
    </Stack>
  );
}
