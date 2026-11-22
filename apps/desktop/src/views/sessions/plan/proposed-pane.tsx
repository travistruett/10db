import classes from './plan-rows.module.css';
import type { ShapeProposalDto, ShapeProposalId, ShapeViewDto } from '@10db/contracts';
import type { OpenRow } from './row-line';
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
import { IconDots } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  useConvertShape,
  useDismissFinding,
  useReviewShape,
  type ReviewKind,
  useRowChange,
} from '../../../daemon/shape-queries';
import { shortAgo } from '../../factory/short-ago';
import { useNow } from '../../../shell/relative';
import { ConvertModal, convertibleRows } from './convert-modal';
import { AttachmentsContext } from './attachments/row-attachments';
import { HeardSoFar } from './heard-so-far';
import { MenuHint } from './menu-hint';
import type { RowAction, RowHandlers } from './proposal-row';
import { FOLDED_AT_FIRST, ProposedList } from './proposed-list';
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
  /** The head's button after Accept that opens the Plan page; the page itself has none. */
  readonly expand?: ReactNode;
  /** The ⋯ menu's Plan section, under its Review section: Export and Undo Accept. */
  readonly planItems?: ReactNode;
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
  /** Whether the head names the Plan; the Plan page names it in its own title row. */
  readonly titled?: boolean;
}

/** The panel's text starts this far from its edges, as the conversation's does from the divider. */
const PANEL_INSET_PX = 40;
/** A row's own inset, inside which its hover tone is drawn. */
const ROW_INSET_PX = 12;
/** On the Plan page, where text lines up with the tabs' labels and the chevrons hang inside. */
const PAGE_INSET_PX = 24;

/** The sidebar: a header, a pinned summary line and the list of proposals, each editable in place. */
export function ProposedPane({
  view,
  loading,
  error,
  summaryHere,
  expand,
  planItems,
  onWhy,
  onAskForChanges,
  jumpRequest = null,
  onJumped,
  titled = true,
}: ProposedPaneProps) {
  // On the Plan page the page's padding does most of the inset; beside the conversation the panel keeps its own.
  const inset = titled ? PANEL_INSET_PX : PAGE_INSET_PX;
  const now = useNow();
  const listRef = useRef<HTMLDivElement>(null);
  const [converting, setConverting] = useState(false);
  const [changesOnly, setChangesOnly] = useState(false);
  // The sections the builder folded: a goal's id, a kind's section, or the run preview.
  const [folded, setFolded] = useState<ReadonlySet<string>>(FOLDED_AT_FIRST);
  // The ⋯ menu is open: its tooltip stays down so it never covers the menu.
  const [menuOpen, setMenuOpen] = useState(false);
  // The panel's one open row; Accept's Read Them opens the first row with notes.
  const [openRow, setOpenRow] = useState<OpenRow | null>(null);
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
  const reviewLine = review.isError
    ? review.error.message
    : takingPictures
      ? 'Design Review is taking pictures of the app.'
      : reviewWords(review.data, turning);
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
  // The filter or a folded section can hide what a count points at (the filter always hides converted
  // rows): the jump lifts the filter, unfolds every section, and lands once the list has rendered.
  const pendingJump = useRef<SectionKey | null>(null);
  const jump = (section: SectionKey): void => {
    if (focusSection(section)) return;
    pendingJump.current = section;
    setChangesOnly(false);
    setFolded(new Set());
  };
  useEffect(() => {
    if (pendingJump.current === null) return;
    focusSection(pendingJump.current);
    pendingJump.current = null;
  }, [filtering, folded]);

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

  // A first proposal's line would only repeat the list below it; a revision's says what changed and when.
  const summary =
    view === undefined || view.shape.round < 2 ? null : (
      <SummaryLine
        groups={groupProposals(view.proposals)}
        onJump={jump}
        lead={`Revision ${String(view.shape.round)}`}
        tail={`revised ${shortAgo(view.shape.updatedAt, now)}`}
        link={
          // Every row changed filters nothing, so the link shows only when some rows stayed put.
          changes.length === 0 || changes.length === view.proposals.length ? null : (
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
              {`${String(changes.length)} changed this round`}
            </Anchor>
          )
        }
      />
    );
  return (
    <Box
      component="section"
      aria-label="Plan"
      h="100%"
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}
    >
      {/* Beside the conversation the head is its own band, ruled off from the list edge to edge, so the
          summary belongs to it; on the Plan page the tabs' rule is above it, and a second would stack. */}
      <Stack
        gap={4}
        px={inset}
        pt={titled ? 20 : 12}
        pb={titled ? 16 : 4}
        style={{
          flex: 'none',
          ...(titled ? { borderBottom: '1px solid var(--mantine-color-default-border)' } : {}),
        }}
      >
        <Group justify="space-between" wrap="nowrap">
          {titled ? (
            <Text fz={18} fw={600} c="bright">
              Plan
            </Text>
          ) : summaryHere && summary !== null ? (
            summary
          ) : (
            <span />
          )}
          <Group gap={8} wrap="nowrap">
            <Tooltip
              label={
                view === undefined || rows.length === 0
                  ? 'Nothing to accept'
                  : 'Put the plan on the Board'
              }
            >
              <Button
                size="xs"
                h={28}
                disabled={view === undefined || rows.length === 0}
                onClick={() => {
                  setConverting(true);
                }}
              >
                Accept
              </Button>
            </Tooltip>
            {expand}
            {view === undefined ? null : (
              <Menu position="bottom-end" withinPortal opened={menuOpen} onChange={setMenuOpen}>
                <Menu.Target>
                  <Tooltip label="Review, export and more" disabled={menuOpen}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="input-xs"
                      aria-label="More Plan actions"
                      loading={review.isPending}
                    >
                      <IconDots size={16} stroke={1.5} />
                    </ActionIcon>
                  </Tooltip>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>Review before you accept</Menu.Label>
                  {REVIEW_ITEMS.map((item) => (
                    <Menu.Item
                      key={item.kind}
                      disabled={rows.length === 0 || review.isPending}
                      onClick={() => {
                        review.mutate(item.kind);
                      }}
                    >
                      <MenuHint hint={item.hint}>{REVIEW_NAMES[item.kind]}</MenuHint>
                    </Menu.Item>
                  ))}
                  {planItems === undefined ? null : (
                    <>
                      <Menu.Divider />
                      {planItems}
                    </>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
        </Group>
        {reviewLine === '' ? null : (
          <Text size="xs" c="dimmed" role="status" aria-label="Review">
            {reviewLine}
          </Text>
        )}
        {summaryHere && titled ? summary : null}
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
        viewportProps={{
          tabIndex: 0,
          role: 'group',
          'aria-label': 'Plan rows',
          className: classes['viewport'],
        }}
        viewportRef={listRef}
      >
        <Box px={inset - ROW_INSET_PX} pt={titled ? 20 : 8} pb={24}>
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
                preview={view.preview}
                folded={folded}
                onFold={(key) => {
                  setFolded((now) => {
                    const next = new Set(now);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  });
                }}
                actionsFor={actionsFor}
                reviewOf={reviewOf}
                handlers={handlers}
                open={openRow}
                onOpenChange={setOpenRow}
                round={view.shape.round}
              />
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
            opened={converting}
            onClose={() => {
              setConverting(false);
            }}
            onReadNotes={(id) => {
              setConverting(false);
              setOpenRow({ id, editing: false });
              // Once the row has opened, bring its notes into view: they end the opened row, often below
              // the fold, and the builder asked for them.
              window.setTimeout(() => {
                const notes = document.querySelector<HTMLElement>(
                  `#shape-row-${id} [aria-label="Review notes"]`,
                );
                notes?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                notes?.focus({ preventScroll: true });
              }, 50);
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
  onClose,
  onReadNotes,
}: {
  readonly view: ShapeViewDto;
  readonly rows: readonly ShapeProposalDto[];
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly onReadNotes: (id: ShapeProposalId) => void;
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
      onReadNotes={(id) => {
        close();
        onReadNotes(id);
      }}
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

/** The ⋯ menu's Review section, each with what it buys. */
const REVIEW_ITEMS: readonly { readonly kind: ReviewKind; readonly hint: string }[] = [
  { kind: 'review', hint: 'Catch scope gaps and engineering risks before anything is built' },
  {
    kind: 'rehearse',
    hint: 'Answer now what a builder would stop to ask, so tasks run straight through',
  },
  {
    kind: 'design_review',
    hint: "Catch mock-ups that drift from the app or DESIGN.md before they're built",
  },
];

const REVIEW_NAMES: Record<ReviewKind, string> = {
  review: 'Plan Review',
  rehearse: 'Find Open Questions',
  design_review: 'Design Review',
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
