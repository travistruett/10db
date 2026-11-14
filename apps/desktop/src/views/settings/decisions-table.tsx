import {
  JudgeDecision,
  type DecisionModelDto,
  type DecisionStatsListDto,
  type JudgeStatusDto,
  type ShadowAgreementDto,
} from '@10db/contracts';
import { Badge, Group, Table, Text, UnstyledButton } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { DECISION_GROUP_LABEL, DECISIONS, groupedDecisions } from './decision-catalogue';
import {
  decisionStatus,
  DecisionStatus,
  lastThirtyDays,
  modelName,
  statsFor,
} from './decision-numbers';

type Row =
  | { readonly kind: 'group'; readonly id: string; readonly label: string }
  | { readonly kind: 'decision'; readonly id: string; readonly decision: JudgeDecision };

const STATUS_BADGE = {
  [DecisionStatus.Acting]: { color: 'teal', variant: 'light' },
  [DecisionStatus.Shadow]: { color: 'gray', variant: 'light' },
  [DecisionStatus.Off]: { color: 'gray', variant: 'outline' },
  [DecisionStatus.AllOff]: { color: 'gray', variant: 'outline' },
} as const;

/** A decision's status as a badge, followed by a dimmed "· no key" while decisions are on and no key is usable. */
export function StatusMark({
  text,
  keyed,
}: {
  readonly text: DecisionStatus;
  readonly keyed: boolean;
}) {
  const allOff = text === DecisionStatus.AllOff;
  return (
    <Group gap={6} wrap="nowrap">
      <Badge {...STATUS_BADGE[text]}>{text}</Badge>
      {keyed || allOff ? null : (
        <Text size="xs" c="dimmed">
          · no key
        </Text>
      )}
    </Group>
  );
}

/**
 * Every decision under its group, with its status, model, Sure enough and last 30 days. A row, or Enter on
 * its name, opens the decision. The master switch and the daemon's kill switch both read as all off.
 */
export function DecisionsTable({
  status,
  stats,
  shadow,
  models,
  onOpen,
}: {
  readonly status: JudgeStatusDto;
  readonly stats: DecisionStatsListDto | undefined;
  readonly shadow: readonly ShadowAgreementDto[] | undefined;
  readonly models: readonly DecisionModelDto[] | undefined;
  readonly onOpen: (decision: JudgeDecision) => void;
}) {
  const { config } = status;
  const allOn = config.enabled && !status.off;
  const keyed = status.account !== null && status.account.secretState === 'set';
  const records: Row[] = groupedDecisions(
    Object.values(JudgeDecision).filter((d) => d in config.decisions),
  ).flatMap(({ group, decisions }) => [
    { kind: 'group', id: `group:${group}`, label: DECISION_GROUP_LABEL[group] },
    ...decisions.map((decision): Row => ({ kind: 'decision', id: decision, decision })),
  ]);
  const ofDecision = (row: Row, then: (d: JudgeDecision) => React.ReactNode) =>
    row.kind === 'decision' ? then(row.decision) : null;
  const columns: DataTableColumn<Row>[] = [
    {
      accessor: 'label',
      title: 'Decision',
      render: (row) =>
        ofDecision(row, (d) => (
          <UnstyledButton
            onClick={(event) => {
              // The row's own click does the same; one opening is enough.
              event.stopPropagation();
              onOpen(d);
            }}
          >
            <Text size="sm" fw={500}>
              {DECISIONS[d].label}
            </Text>
          </UnstyledButton>
        )),
    },
    {
      accessor: 'status',
      title: 'Status',
      noWrap: true,
      render: (row) =>
        ofDecision(row, (d) => {
          const text = decisionStatus(DECISIONS[d].mode, config.decisions[d].enabled, allOn);
          return <StatusMark text={text} keyed={keyed} />;
        }),
    },
    {
      accessor: 'model',
      title: 'Model',
      noWrap: true,
      render: (row) => ofDecision(row, (d) => modelName(config.decisions[d].model, models)),
    },
    {
      accessor: 'floor',
      title: 'Sure enough',
      noWrap: true,
      render: (row) =>
        ofDecision(row, (d) => `${String(Math.round(config.decisions[d].floor * 100))}%`),
    },
    {
      accessor: 'last30',
      title: 'Last 30 days',
      noWrap: true,
      render: (row) =>
        ofDecision(row, (d) =>
          lastThirtyDays(
            statsFor(stats, d),
            DECISIONS[d].mode,
            shadow?.find((a) => a.decision === d),
          ),
        ),
    },
  ];
  return (
    <DataTable<Row>
      aria-label="Decisions"
      records={records}
      columns={columns}
      idAccessor="id"
      withTableBorder
      borderRadius="md"
      verticalSpacing="sm"
      horizontalSpacing="md"
      highlightOnHover
      onRowClick={({ record }) => {
        if (record.kind === 'decision') onOpen(record.decision);
      }}
      rowStyle={(record) =>
        record.kind === 'group'
          ? { background: 'var(--mantine-color-body)', cursor: 'default' }
          : { cursor: 'pointer' }
      }
      rowFactory={({ record, rowProps, children }) =>
        record.kind === 'group' ? (
          <Table.Tr {...rowProps} onClick={undefined} data-group>
            <Table.Th
              scope="rowgroup"
              colSpan={5}
              fz="xs"
              fw={600}
              c="dimmed"
              tt="uppercase"
              bg="var(--mantine-color-body)"
            >
              {record.label}
            </Table.Th>
          </Table.Tr>
        ) : (
          <Table.Tr {...rowProps}>{children}</Table.Tr>
        )
      }
    />
  );
}
