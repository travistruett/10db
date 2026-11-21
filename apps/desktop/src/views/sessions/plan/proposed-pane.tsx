import type { ShapeProposalDto, ShapeViewDto } from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Button,
  Group,
  Menu,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconChevronDown, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  useConvertShape,
  useDismissFinding,
  useReviewShape,
  type ReviewKind,
  useRowChange,
} from '../../../daemon/shape-queries';
import { SplitButton } from '../../../shell/split-button';
import { shortAgo } from '../../factory/short-ago';
import { useNow } from '../../../shell/relative';
import { ConvertModal, convertibleRows } from './convert-modal';
import { AttachmentsContext } from './attachments/row-attachments';
import { HeardSoFar } from './heard-so-far';
import { PreviewPanel } from './preview-panel';
import type { RowAction, RowHandlers } from './proposal-row';
import { ProposedList } from './proposed-list';
import { groupProposals, roundChanges, type SectionKey } from './proposed-groups';
import { rowReview } from './review-lines';
import { SummaryLine } from './summary-line';
import {
  RemoveDraftGoalModal,
  WithdrawDecisionModal,
  WithdrawPrincipleModal,
  type PrincipleWithdrawTarget,
  type RemoveDraftGoalTarget,
  type WithdrawTarget,
} from './undo-modals';

export interface ProposedPaneProps {
  readonly view: ShapeViewDto | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  /** Whether the summary line sits here; in the drawer layout the view keeps it always on screen. */
  readonly summaryHere: boolean;
  /** The head's controls after Accept: the panel's ⋯ menu. */
  readonly menu?: ReactNode;
  /** Closes the panel; absent when the drawer around it has its own close. */
  readonly onClose?: () => void;
  /** Why?: scrolls the conversation to the messages a row came from and highlights them. */
  readonly onWhy: (row: ShapeProposalDto) => void;
  /** Ask for Changes on a mock-up: the session's composer takes the words. */
  readonly onAskForChanges: (text: string) => void;
  /**
   * A count in the bar's summary line asked for this section while the pane was a drawer. The pane
   * focuses the section's first row once it has the rows (a drawer mounts it on open) and calls
   * `onJumped`, so a later open starts at the top.
   */
  readonly jumpRequest?: { readonly section: SectionKey; readonly nonce: number } | null;
  readonly onJumped?: () => void;
}

/** The sidebar: a header, a pinned summary line and the list of proposals, each editable in place. */
export function ProposedPane({
  view,
  loading,
  error,
  summaryHere,
  menu,
  onClose,
  onWhy,
  onAskForChanges,
  jumpRequest = null,
  onJumped,
}: ProposedPaneProps) {
  const now = useNow();
  const listRef = useRef<HTMLDivElement>(null);
  const [converting, setConverting] = useState<'accept' | 'start' | null>(null);
  const [changesOnly, setChangesOnly] = useState(false);
  const [goalToRemove, setGoalToRemove] = useState<RemoveDraftGoalTarget | null>(null);
  const [decisionToWithdraw, setDecisionToWithdraw] = useState<WithdrawTarget | null>(null);
  const [principleToWithdraw, setPrincipleToWithdraw] = useState<PrincipleWithdrawTarget | null>(
    null,
  );
  const change = useRowChange(view?.shape.id ?? null);

  const changes = roundChanges(view?.proposals ?? []);
  // A filter on a round with nothing to show would hide the whole list: it shows only while there is something.
  const filtering = changesOnly && changes.length > 0;
  const groups = groupProposals(filtering ? changes : (view?.proposals ?? []));
  const rows = convertibleRows(view?.proposals ?? []);
  const hasProposals = (view?.proposals.length ?? 0) > 0;
  const dismiss = useDismissFinding(view?.shape.id ?? null);
  const review = useReviewShape(view?.shape.id ?? null);
  // A Design review takes its pictures before its turn is queued: the press waits for them.
  const takingPictures = review.isPending && review.variables === 'design_review';
  // "Is running" is true only while a turn runs or waits; it goes when the review's turn ends.
  const turning = view !== undefined && (view.turn.running || view.turn.queued > 0);
  const reviewLine = review.isError ? review.error.message : reviewWords(review.data, turning);
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

  const focusSection = (section: SectionKey): boolean => {
    const target = listRef.current?.querySelector<HTMLElement>(`[data-section="${section}"]`);
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
    return target != null;
  };
  // The filter can hide what a count points at (it always hides converted rows): the jump lifts
  // it, and lands once the full list has rendered. A section the filter shows leaves it on.
  const jumpAfterFilter = useRef<SectionKey | null>(null);
  const jump = (section: SectionKey): void => {
    if (focusSection(section) || !filtering) return;
    jumpAfterFilter.current = section;
    setChangesOnly(false);
  };
  useEffect(() => {
    if (filtering || jumpAfterFilter.current === null) return;
    focusSection(jumpAfterFilter.current);
    jumpAfterFilter.current = null;
  }, [filtering]);

  // The rows exist once the view has loaded; until then the request waits.
  const ready = view !== undefined && !loading && error === null;
  useEffect(() => {
    if (jumpRequest === null || !ready) return;
    // Only the rendered list can say whether the filter hides the section, so a request that it
    // does lifts the filter from here: one extra render, once per request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    jump(jumpRequest.section);
    onJumped?.();
    // A request is handled once, by its nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest?.nonce, ready]);

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
      // A withdrawn decision is gone, and a replaced one is not the head of its chain.
      if (row.converted.withdrawn === true || row.converted.superseded === true) return [];
      const { decisionId } = row.converted;
      return [
        {
          label: 'Withdraw Decision',
          onSelect: () => {
            setDecisionToWithdraw({ decisionId, title: row.body.choice });
          },
        },
      ];
    }
    if (row.kind === 'principle' && row.converted?.principleId != null) {
      // A withdrawn or retired principle is gone, and a replaced one is not the head of its chain:
      // only a current or proposed principle can be withdrawn.
      const { withdrawn, superseded, retired } = row.converted;
      if (withdrawn === true || superseded === true || retired === true) return [];
      const { principleId } = row.converted;
      return [
        {
          label: 'Withdraw Principle',
          onSelect: () => {
            setPrincipleToWithdraw({ principleId, title: row.body.statement });
          },
        },
      ];
    }
    return [];
  };

  return (
    <Box
      component="section"
      aria-label="Plan"
      h="100%"
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}
    >
      <Stack gap={6} px="md" pt="md" pb={12} style={{ flex: 'none' }}>
        <Group justify="space-between" wrap="nowrap">
          <Text fz={16} fw={600}>
            Plan
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Tooltip label="Have reviewers read the plan before you accept it">
                  <Button
                    variant="subtle"
                    color="gray"
                    size="xs"
                    rightSection={<IconChevronDown size={14} stroke={1.5} />}
                    loading={review.isPending && review.variables !== 'design_review'}
                    disabled={view === undefined || rows.length === 0 || takingPictures}
                  >
                    {takingPictures ? 'Taking pictures' : 'Review'}
                  </Button>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  onClick={() => {
                    review.mutate('review');
                  }}
                >
                  <ReviewItem hint="Scope and engineering reviewers read each goal and loose task">
                    Plan review
                  </ReviewItem>
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    review.mutate('rehearse');
                  }}
                >
                  <ReviewItem hint="Reads each task as the agent who will build it, for what it would have to ask">
                    Check for Questions
                  </ReviewItem>
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    review.mutate('design_review');
                  }}
                >
                  <ReviewItem hint="Compares each task's mock-up with the app as it is now and DESIGN.md">
                    Design review
                  </ReviewItem>
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <SplitButton
              size="xs"
              disabledReason={view === undefined || rows.length === 0 ? 'Nothing to accept' : null}
              onClick={() => {
                setConverting('accept');
              }}
              hint="Put the pending rows on the Board. Nothing starts."
              menuLabel="More ways to accept"
              menu={
                <>
                  <Menu.Item
                    onClick={() => {
                      setConverting('accept');
                    }}
                  >
                    Accept
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => {
                      setConverting('start');
                    }}
                  >
                    <ReviewItem hint="Also starts the accepted tasks that are ready">
                      Accept and Start
                    </ReviewItem>
                  </Menu.Item>
                </>
              }
            >
              Accept
            </SplitButton>
            <Group gap={4} wrap="nowrap">
              {menu}
              {onClose === undefined ? null : (
                <Tooltip label="Close Plan">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="input-xs"
                    aria-label="Close Plan"
                    onClick={onClose}
                  >
                    <IconX size={16} stroke={1.5} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          </Group>
        </Group>
        {reviewLine === '' ? null : (
          <Text size="xs" c="dimmed" role="status" aria-label="Review">
            {reviewLine}
          </Text>
        )}
        {summaryHere ? (
          <SummaryLine
            groups={groupProposals(view?.proposals ?? [])}
            onJump={jump}
            lead={
              view === undefined || view.shape.round === 0
                ? null
                : `Round ${String(view.shape.round)}`
            }
            tail={
              view === undefined || view.shape.round === 0
                ? null
                : shortAgo(view.shape.updatedAt, now)
            }
            link={
              changes.length === 0 ? null : (
                <Anchor
                  component="button"
                  type="button"
                  fz={12}
                  c="dimmed"
                  underline={filtering ? 'always' : 'hover'}
                  aria-pressed={filtering}
                  onClick={() => {
                    setChangesOnly((on) => !on);
                  }}
                >
                  {`${String(changes.length)} ${changes.length === 1 ? 'change' : 'changes'}`}
                </Anchor>
              )
            }
          />
        ) : null}
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
      </Stack>
      <ScrollArea
        style={{ flex: 1, minHeight: 0 }}
        viewportProps={{ tabIndex: 0, role: 'group', 'aria-label': 'Plan rows' }}
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
            <AttachmentsContext
              value={{ shapeId: view.shape.id, attachments: view.attachments, onAskForChanges }}
            >
              <ProposedList
                projectId={view.shape.projectId}
                groups={groups}
                sizes={view.sizes}
                actionsFor={actionsFor}
                reviewOf={reviewOf}
                handlers={handlers}
              />
              <PreviewPanel preview={view.preview} />
            </AttachmentsContext>
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
            opened={converting !== null}
            start={converting === 'start'}
            onClose={() => {
              setConverting(null);
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
          <WithdrawPrincipleModal
            shapeId={view.shape.id}
            target={principleToWithdraw}
            onClose={() => {
              setPrincipleToWithdraw(null);
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
  start,
  onClose,
}: {
  readonly view: ShapeViewDto;
  readonly rows: readonly ShapeProposalDto[];
  readonly opened: boolean;
  readonly start: boolean;
  readonly onClose: () => void;
}) {
  const convert = useConvertShape(view.shape.id);
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
      start={start}
      rows={rows}
      view={view}
      pending={convert.isPending}
      refusals={refusals}
      failure={convert.error?.message ?? null}
      onConvert={async (ids, options) => {
        setRefusals([]);
        const result = await convert
          .mutateAsync({
            proposalIds: ids,
            ...(options?.cut === undefined ? {} : { cut: options.cut }),
            ...(options?.start === true ? { start: true } : {}),
          })
          .catch(() => undefined);
        if (result?.kind === 'refused') setRefusals(result.errors);
        return result;
      }}
    />
  );
}

const REVIEW_NAMES: Record<ReviewKind, string> = {
  review: 'Plan review',
  rehearse: 'Check for Questions',
  design_review: 'Design review',
};

/** What a press that found nothing to read says. */
const NOTHING_TO_SAY: Record<ReviewKind, string> = {
  review: 'Nothing to review.',
  rehearse: 'Every task has been checked.',
  design_review: 'Nothing to review: no task has both a mock-up and a page.',
};

/** What a review press came to, in words. */
function reviewWords(
  answer:
    { readonly kind: ReviewKind; readonly result: { status: string; tasks: number } } | undefined,
  turning: boolean,
): string {
  if (answer === undefined) return '';
  const what = REVIEW_NAMES[answer.kind];
  if (answer.result.status === 'started') return turning ? `${what} is running.` : '';
  // A refused press always says why, whether or not a turn shows.
  if (answer.result.status === 'running')
    return 'A review is already running; press again when it ends.';
  return NOTHING_TO_SAY[answer.kind];
}

/** A menu item's name with a dimmed line saying what it does. */
function ReviewItem({ hint, children }: { readonly hint: string; readonly children: ReactNode }) {
  return (
    <Stack gap={0}>
      <Text size="sm">{children}</Text>
      <Text size="xs" c="dimmed" maw={260}>
        {hint}
      </Text>
    </Stack>
  );
}
