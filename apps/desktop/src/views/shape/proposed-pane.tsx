import type { ShapeProposalDto, ShapeViewDto } from '@10db/contracts';
import { Alert, Box, Button, Group, ScrollArea, Skeleton, Stack, Text } from '@mantine/core';
import { useRef, useState } from 'react';
import {
  useConvertShape,
  useDismissFinding,
  useRehearseShape,
  useRowChange,
  useStopShape,
} from '../../daemon/shape-queries';
import { shortAgo } from '../factory/short-ago';
import { useNow } from '../../shell/relative';
import { ConvertModal, convertibleRows } from './convert-modal';
import { HeardSoFar } from './heard-so-far';
import type { RowAction, RowHandlers } from './proposal-row';
import { ProposedList } from './proposed-list';
import { groupProposals, roundChanges, type SectionKey } from './proposed-groups';
import { rowReview } from './review-lines';
import { SummaryLine } from './summary-line';
import {
  RemoveDraftGoalModal,
  WithdrawDecisionModal,
  type RemoveDraftGoalTarget,
  type WithdrawTarget,
} from './undo-modals';

export interface ProposedPaneProps {
  readonly view: ShapeViewDto | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  /** Whether the summary line sits here; in the drawer layout the view keeps it always on screen. */
  readonly summaryHere: boolean;
  /** Why?: scrolls the conversation to the messages a row came from and highlights them. */
  readonly onWhy: (row: ShapeProposalDto) => void;
}

/** The sidebar: a header, a pinned summary line and the list of proposals, each editable in place. */
export function ProposedPane({ view, loading, error, summaryHere, onWhy }: ProposedPaneProps) {
  const now = useNow();
  const listRef = useRef<HTMLDivElement>(null);
  const [converting, setConverting] = useState(false);
  const [changesOnly, setChangesOnly] = useState(false);
  const [goalToRemove, setGoalToRemove] = useState<RemoveDraftGoalTarget | null>(null);
  const [decisionToWithdraw, setDecisionToWithdraw] = useState<WithdrawTarget | null>(null);
  const change = useRowChange(view?.shape.id ?? null);

  const changes = roundChanges(view?.proposals ?? []);
  // A filter on a round with nothing to show would hide the whole list: it shows only while there is something.
  const filtering = changesOnly && changes.length > 0;
  const groups = groupProposals(filtering ? changes : (view?.proposals ?? []));
  const rows = convertibleRows(view?.proposals ?? []);
  const hasProposals = (view?.proposals.length ?? 0) > 0;
  const dismiss = useDismissFinding(view?.shape.id ?? null);
  const rehearse = useRehearseShape(view?.shape.id ?? null);
  const handlers: RowHandlers = {
    onChange: (row, action) => {
      change.mutate({ id: row.id, action });
    },
    onWhy,
    onDismiss: (findingId) => {
      dismiss.mutate({ findingId });
    },
  };
  // The ceremony, findings and rehearsal questions show under a pending goal or task.
  const reviewOf = (row: ShapeProposalDto) =>
    view !== undefined && row.state === 'pending' && (row.kind === 'goal' || row.kind === 'task')
      ? rowReview(view, row)
      : undefined;
  const unread = view?.rehearsals.some((r) => !r.rehearsed) ?? false;

  const jump = (section: SectionKey): void => {
    const target = listRef.current?.querySelector<HTMLElement>(`[data-section="${section}"]`);
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  };

  const actionsFor = (row: ShapeProposalDto): RowAction[] => {
    if (row.state !== 'accepted') return [];
    if (row.kind === 'goal' && row.converted?.goalId != null) {
      const { goalId } = row.converted;
      return [
        {
          label: 'Remove Draft Goal',
          onSelect: () => {
            setGoalToRemove({ goalId, title: row.body.title, taskCount: row.body.tasks.length });
          },
        },
      ];
    }
    if (row.kind === 'decision' && row.converted?.decisionId != null) {
      if (row.converted.withdrawn === true) return [];
      const { decisionId } = row.converted;
      return [
        {
          label: 'Withdraw Decision…',
          onSelect: () => {
            setDecisionToWithdraw({ decisionId, title: row.body.choice });
          },
        },
      ];
    }
    return [];
  };

  return (
    <Box
      component="section"
      aria-label="Proposed"
      h="100%"
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}
    >
      <Stack gap={6} px="md" pt="md" pb="xs" style={{ flex: 'none' }}>
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm" fw={500}>
            {view === undefined || view.shape.round === 0
              ? 'Proposed'
              : `Proposed · round ${String(view.shape.round)} · updated ${shortAgo(view.shape.updatedAt, now)}`}
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Button
              variant="default"
              size="xs"
              disabled={view === undefined || !unread || view.turn.rehearsing || rehearse.isPending}
              onClick={() => {
                rehearse.mutate(undefined);
              }}
            >
              {view?.turn.rehearsing === true ? 'Rehearsing…' : 'Rehearse'}
            </Button>
            <Button
              variant="default"
              size="xs"
              disabled={view === undefined || rows.length === 0}
              onClick={() => {
                setConverting(true);
              }}
            >
              Convert…
            </Button>
          </Group>
        </Group>
        {summaryHere ? (
          <SummaryLine groups={groupProposals(view?.proposals ?? [])} onJump={jump} />
        ) : null}
        {changes.length === 0 || view === undefined ? null : (
          <Button
            variant="subtle"
            size="compact-xs"
            style={{ alignSelf: 'flex-start' }}
            aria-pressed={filtering}
            onClick={() => {
              setChangesOnly((on) => !on);
            }}
          >
            {`${String(changes.length)} ${changes.length === 1 ? 'change' : 'changes'} in round ${String(view.shape.round)}`}
          </Button>
        )}
        {change.isError ? (
          <Alert color="red" title="Couldn't change the row">
            {change.error.message}
          </Alert>
        ) : null}
        {dismiss.isError ? (
          <Alert color="red" title="Couldn't dismiss it">
            {dismiss.error.message}
          </Alert>
        ) : null}
        {rehearse.isError ? (
          <Alert color="red" title="Couldn't start the rehearsal">
            {rehearse.error.message}
          </Alert>
        ) : null}
      </Stack>
      <ScrollArea
        style={{ flex: 1, minHeight: 0 }}
        viewportProps={{ tabIndex: 0, role: 'group', 'aria-label': 'Proposed list' }}
        viewportRef={listRef}
      >
        <Box px="md" pb="md">
          {error !== null ? (
            <Alert color="red" title="Couldn't load the proposals">
              {error}
            </Alert>
          ) : loading ? (
            <Stack gap="sm" aria-hidden="true">
              <Skeleton height={14} width="60%" />
              <Skeleton height={14} />
              <Skeleton height={14} width="80%" />
            </Stack>
          ) : view !== undefined && hasProposals ? (
            <ProposedList
              groups={groups}
              sizes={view.sizes}
              actionsFor={actionsFor}
              reviewOf={reviewOf}
              handlers={handlers}
            />
          ) : (
            <HeardSoFar heard={view?.heard ?? []} />
          )}
        </Box>
      </ScrollArea>
      {view === undefined ? null : (
        <>
          <ConvertPanel
            view={view}
            rows={rows}
            opened={converting}
            onClose={() => {
              setConverting(false);
            }}
          />
          <RemoveDraftGoalModal
            target={goalToRemove}
            onClose={() => {
              setGoalToRemove(null);
            }}
          />
          <WithdrawDecisionModal
            shapeId={view.shape.id}
            target={decisionToWithdraw}
            onClose={() => {
              setDecisionToWithdraw(null);
            }}
          />
        </>
      )}
    </Box>
  );
}

function ConvertPanel({
  view,
  rows,
  opened,
  onClose,
}: {
  readonly view: ShapeViewDto;
  readonly rows: readonly ShapeProposalDto[];
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  const convert = useConvertShape(view.shape.id);
  const stop = useStopShape();
  const rehearse = useRehearseShape(view.shape.id);
  const { mutate: startRehearsal } = rehearse;
  const [refusals, setRefusals] = useState<readonly string[]>([]);
  const close = () => {
    setRefusals([]);
    convert.reset();
    onClose();
  };
  return (
    <ConvertModal
      opened={opened}
      onClose={close}
      rows={rows}
      view={view}
      answering={view.turn.running}
      pending={convert.isPending}
      refusals={refusals}
      failure={convert.error?.message ?? null}
      onConvert={async (ids, options) => {
        setRefusals([]);
        const result = await convert
          .mutateAsync({
            proposalIds: ids,
            ...(options?.interrupt === true ? { interrupt: true } : {}),
          })
          .catch(() => undefined);
        if (result?.kind === 'refused') setRefusals(result.errors);
        return result;
      }}
      onStop={() => {
        stop.mutate(view.shape.id);
      }}
      onRehearse={(ids) => {
        startRehearsal(ids);
      }}
    />
  );
}
