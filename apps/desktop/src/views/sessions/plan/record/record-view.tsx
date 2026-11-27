import type { PlanRecordDto, ShapeId } from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Badge,
  Container,
  Group,
  Stack,
  Tabs,
  Text,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import { PageLoading, PageLoadingShape } from '../../../../shell/page-loading';
import { usePlanRecord } from '../../../../daemon/plan-record-queries';
import { useShapeView } from '../../../../daemon/shape-queries';
import { useOpenSessionNotice } from '../../open-session';
import { TitleRow } from '../../../../shell/title-row';
import { DecisionsTab } from './decisions-tab';
import { DocumentsTab } from './documents-tab';
import { EvidenceTab } from './evidence-tab';
import { ExportButton } from './export-button';
import { PlanPanel } from '../plan-panel';
import { proposalTitle } from '../proposal-text';
import { draftKey, sessionDrafts } from '../../session-drafts';
import { QuestionsTab } from './questions-tab';
import { RECORD_TABS, RecordTab, type RecordSearch } from './record-tabs';
import { ReviewsTab } from './reviews-tab';
import { TasksTab } from './tasks-tab';
import { ContentWidth } from '../../../../shell/content-width';

// The Plan page: the Plan the session's panel shows, full width, then its record: the documents an effort
// wrote, what it decided, the evidence it read, its reviews, what it left open and the tasks made from it.

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
    readonly plan: ReactNode;
    readonly titles: ReadonlyMap<string, string>;
    readonly onAskToFix: (text: string) => void;
  },
): ReactNode {
  switch (tab) {
    case RecordTab.Plan:
      return props.plan;
    case RecordTab.Documents:
      return <DocumentsTab {...props} />;
    case RecordTab.Decisions:
      return <DecisionsTab shapeId={props.shapeId} />;
    case RecordTab.Evidence:
      return <EvidenceTab shapeId={props.shapeId} />;
    case RecordTab.Reviews:
      return (
        <ReviewsTab shapeId={props.shapeId} titles={props.titles} onAskToFix={props.onAskToFix} />
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
  plan,
  titles,
  onAskToFix,
}: {
  readonly shapeId: ShapeId;
  readonly record: PlanRecordDto;
  readonly tab: RecordTab;
  readonly search: RecordSearch;
  readonly onSearch: (next: RecordSearch) => void;
  readonly plan: ReactNode;
  readonly titles: ReadonlyMap<string, string>;
  readonly onAskToFix: (text: string) => void;
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
            overflowY:
              t.tab === RecordTab.Documents || t.tab === RecordTab.Plan ? 'hidden' : 'auto',
          }}
        >
          {panelOf(t.tab, { shapeId, record, search, onSearch, plan, titles, onAskToFix })}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

/**
 * The record while it loads: its real tab list, with no counts yet, over a placeholder in the shape of
 * the Plan panel it opens on.
 */
function RecordLoading({ tab }: { readonly tab: RecordTab }) {
  return (
    <Tabs value={tab} keepMounted={false}>
      <Tabs.List>
        {RECORD_TABS.map((t) => (
          <Tabs.Tab key={t.tab} value={t.tab}>
            {t.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      <Tabs.Panel value={tab} pt="md">
        <PageLoading shape={PageLoadingShape.List} rows={5} label="Loading the record" />
      </Tabs.Panel>
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
  const view = useShapeView(shapeId).data;
  const chatId = view?.chatId ?? null;
  // What each key the record names is called on the Plan: a row's title, and a goal's tasks' titles.
  const titles = new Map(
    (view?.proposals ?? []).flatMap((row) => [
      [row.key, proposalTitle(row)] as const,
      ...(row.kind === 'goal' ? row.body.tasks.map((t) => [t.key, t.title] as const) : []),
    ]),
  );
  const { open, notice } = useOpenSessionNotice();
  const tab = search.tab ?? RecordTab.Plan;
  const back = (): void => {
    if (chatId !== null) open(chatId);
  };
  // Hands words to the session as the start of the builder's reply, and goes back to it.
  const toSession = (text: string): void => {
    if (chatId === null) return;
    const key = draftKey.chat(chatId);
    const now = sessionDrafts.get(key);
    sessionDrafts.set(key, { ...now, text: now.text === '' ? text : `${now.text}\n${text}` });
    back();
  };
  // The Plan's rows, as the panel shows them. Where it came from and Ask for Changes go back to the
  // session, the second with its words in the session's draft.
  const plan = (
    <Container size={ContentWidth.Reading} w="100%" h="100%" style={{ minHeight: 0 }}>
      <PlanPanel shapeId={shapeId} full onWhy={back} onAskForChanges={toSession} />
    </Container>
  );
  const imported = record.data === undefined ? null : importedLine(record.data);
  return (
    <Stack
      component="section"
      aria-label="Plan page"
      gap="sm"
      p="md"
      // A flex item of the shell's main column, as Plan's split pane is, so its height is the window's.
      style={{ flex: '1 1 0px', minHeight: 420 }}
    >
      {/* Where the builder is: a back button to the session the plan belongs to, then the page's name. */}
      <TitleRow
        title={
          <Group gap={12} wrap="nowrap">
            <Tooltip label={`Back to ${record.data?.title ?? 'the session'}`}>
              <ActionIcon
                variant="default"
                size={28}
                aria-label="Back to the session"
                disabled={chatId === null}
                onClick={back}
              >
                <IconArrowLeft size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
            {/* The page's name and the session's title share one baseline. */}
            <Group gap={8} align="baseline" wrap="nowrap" style={{ minWidth: 0 }}>
              <span>Plan</span>
              <Text component="span" fz={12} fw={400} c="dimmed" truncate="end">
                {record.data?.title}
              </Text>
            </Group>
          </Group>
        }
        actions={<ExportButton shapeId={shapeId} />}
      />
      {notice}
      {imported === null ? null : (
        <Text size="xs" c="dimmed">
          {imported}
        </Text>
      )}
      {record.isError ? (
        <Alert color="red" title="Couldn't load the record">
          {record.error.message}
        </Alert>
      ) : record.data === undefined ? (
        <RecordLoading tab={tab} />
      ) : (
        <RecordTabs
          shapeId={shapeId}
          record={record.data}
          tab={tab}
          search={search}
          onSearch={onSearch}
          plan={plan}
          titles={titles}
          onAskToFix={toSession}
        />
      )}
    </Stack>
  );
}
