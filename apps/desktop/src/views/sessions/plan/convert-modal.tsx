import {
  MILESTONES_BEFORE_CUT,
  MilestoneMark,
  type MilestoneCut,
  type ShapeProposalDto,
  type ShapeProposalId,
  type GoalId,
  type ShapeConvertResult,
  type ShapeStartCountsDto,
  type ShapeViewDto,
} from '@10db/contracts';
import { Anchor, Button, Checkbox, Group, Radio, ScrollArea, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useStartCounts, type ConvertShapeResult } from '../../../daemon/shape-queries';
import { FormModal } from '../../../shell/form-modal';
import { destination, proposalTitle } from './proposal-text';
import { isConverted } from './proposed-groups';
import { convertWarnings, rowReview } from './review-lines';

const MARKS = [
  { value: MilestoneMark.Needed, label: 'Needed For The Goal' },
  { value: MilestoneMark.Later, label: 'Later' },
  { value: MilestoneMark.Cut, label: 'Cut' },
] as const;

/** The rows Convert can write now: the pending ones. */
export function convertibleRows(proposals: readonly ShapeProposalDto[]): ShapeProposalDto[] {
  return proposals.filter((p) => p.state === 'pending' && !isConverted(p));
}

/** What Accept and Start would do, counted; a part that is zero drops out. */
export function startCountsLine(counts: ShapeStartCountsDto): string {
  const waits = [
    counts.forLane === 0 ? null : `${String(counts.forLane)} wait for a lane`,
    counts.forOthers === 0
      ? null
      : `${String(counts.forOthers)} ${counts.forLane === 0 ? 'wait ' : ''}for other tasks`,
  ].filter((part) => part !== null);
  return [
    counts.now === 0 ? null : `${String(counts.now)} start now`,
    waits.length === 0 ? null : waits.join(', '),
  ]
    .filter((part) => part !== null)
    .join('; ');
}

/** A row's open review notes, counted as its row in the panel counts them. */
function notesCount(view: ShapeViewDto, row: ShapeProposalDto): number {
  if (row.kind !== 'goal' && row.kind !== 'task') return 0;
  const review = rowReview(view, row);
  const questions = row.kind === 'goal' ? 0 : review.tasks.flatMap((t) => t.questions).length;
  return review.findings.length + questions;
}

/** The goals an Accept made, each with its title from the Plan's row and its task count. */
function madeGoals(
  result: ShapeConvertResult,
  rows: readonly ShapeProposalDto[],
): { readonly goalId: GoalId; readonly title: string; readonly tasks: number }[] {
  if (result.createdNow === 0) return [];
  return result.results.flatMap((r) => {
    const row = rows.find((p) => p.key === r.key && p.kind === r.kind);
    return r.kind === 'goal' && r.goalId !== undefined && row !== undefined
      ? [{ goalId: r.goalId, title: proposalTitle(row), tasks: r.taskIds.length }]
      : [];
  });
}

/** "Board polish is a goal now, with 2 tasks. Nothing has started; find it under Goals." */
function madeLine(
  made: readonly { readonly title: string; readonly tasks: number }[],
  start: ShapeConvertResult['start'],
): string {
  const head =
    made.length === 1 && made[0] !== undefined
      ? `${made[0].title} is a goal now, with ${String(made[0].tasks)} ${made[0].tasks === 1 ? 'task' : 'tasks'}.`
      : `${String(made.length)} goals made: ${made.map((m) => m.title).join(', ')}.`;
  const started = start?.started.length ?? 0;
  const tail =
    started === 0
      ? 'Nothing has started; find it under Goals.'
      : `${String(started)} ${started === 1 ? 'task' : 'tasks'} started; follow ${made.length === 1 ? 'it' : 'them'} under Goals.`;
  return `${head} ${tail}`;
}

export interface ConvertModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly rows: readonly ShapeProposalDto[];
  /** What the review has to say: ceremony, findings and the rehearsal's marks and questions. */
  readonly view: ShapeViewDto;
  readonly pending: boolean;
  /** Every reason the last Convert was refused; nothing was written. */
  readonly refusals: readonly string[];
  /** The daemon's words when the request itself failed. */
  readonly failure: string | null;
  /** Read Them: closes the modal and opens this row, the first ticked one with notes, in the panel. */
  readonly onReadNotes?: (id: ShapeProposalId) => void;
  readonly onConvert: (
    ids: readonly ShapeProposalId[],
    options?: { readonly cut?: readonly MilestoneCut[]; readonly start?: boolean },
  ) => Promise<ConvertShapeResult | undefined>;
}

/**
 * A form modal with a checkbox per pending proposal and where it goes, then Accept, which only puts them
 * on the Board, and the primary Accept and Start, which also starts what is ready; a line counts what
 * would wait only when something would. With nothing that would start, Accept is the one primary. Open
 * notes warn, with Read Them, which opens the first row that has some in the panel. Accept never
 * starts or stops a turn. Open questions and findings warn and never block.
 */
export function ConvertModal({
  opened,
  onClose,
  rows,
  view,
  pending,
  refusals,
  failure,
  onReadNotes,
  onConvert,
}: ConvertModalProps) {
  const [unticked, setUnticked] = useState<ReadonlySet<ShapeProposalId>>(new Set());
  const [marks, setMarks] = useState<ReadonlyMap<ShapeProposalId, MilestoneMark>>(new Map());
  // The rows there were when the modal opened. A round that lands under it adds rows, ticked, and the
  // builder's unticks and marks stay as they were.
  const [openedWith, setOpenedWith] = useState<ReadonlySet<ShapeProposalId> | null>(null);
  if (opened && openedWith === null) setOpenedWith(new Set(rows.map((r) => r.id)));
  if (!opened && openedWith !== null) {
    setOpenedWith(null);
    setUnticked(new Set());
    setMarks(new Map());
  }
  const arrived = openedWith === null ? 0 : rows.filter((r) => !openedWith.has(r.id)).length;
  // A Plan with many milestones is cut first: each milestone's mark, not a tick, decides whether it converts.
  const milestones = rows.filter((r) => r.kind === 'goal');
  const cutting = milestones.length > MILESTONES_BEFORE_CUT;
  const unmarked = cutting ? milestones.filter((m) => !marks.has(m.id)) : [];
  const listed = cutting ? rows.filter((r) => r.kind !== 'goal') : rows;
  const chosen = rows.filter((r) =>
    cutting && r.kind === 'goal' ? marks.get(r.id) === MilestoneMark.Needed : !unticked.has(r.id),
  );
  const counts = useStartCounts(
    view.shape.id,
    chosen.map((r) => r.id),
    opened,
  ).data;
  // Nothing in what is ticked would start: Accept and Start is not offered.
  const startsAny = counts === undefined || counts.now + counts.forLane + counts.forOthers > 0;
  // After an Accept the start could not follow, or had nothing new: the modal stays until Done.
  const [after, setAfter] = useState<{
    readonly line: string;
    readonly refused: boolean;
    /** The goal this Accept made, when it made one: Open Goal goes to its page. */
    readonly goalId?: GoalId;
  } | null>(null);
  const navigate = useNavigate();
  if (!opened && after !== null) setAfter(null);
  const beside = refusals.length > 0 ? refusals : failure === null ? [] : [failure];
  const rehearsing = view.turn.rehearsing;
  const rehearsingCount = chosen
    .flatMap((r) => rowReview(view, r).tasks)
    .filter((t) => t.state === 'rehearsing').length;
  const warnings = convertWarnings(view, chosen, rehearsing);
  const withNotes = chosen.find((r) => notesCount(view, r) > 0);

  const convert = async (starting: boolean): Promise<void> => {
    const ids = chosen.map((r) => r.id);
    const cut = cutting
      ? milestones.flatMap((m): MilestoneCut[] => {
          const mark = marks.get(m.id);
          return mark === undefined ? [] : [{ proposalId: m.id, mark }];
        })
      : undefined;
    const options = {
      ...(cut === undefined ? {} : { cut }),
      ...(starting ? { start: true } : {}),
    };
    const result = await onConvert(ids, options);
    if (result?.kind !== 'converted') return;
    const outcome = result.result.start;
    const made = madeGoals(result.result, rows);
    if (outcome?.refused != null)
      setAfter({
        line: `Accepted. The start was refused: ${outcome.refused}`,
        refused: true,
        ...(made[0] === undefined ? {} : { goalId: made[0].goalId }),
      });
    else if (made[0] !== undefined)
      setAfter({ line: madeLine(made, outcome), refused: false, goalId: made[0].goalId });
    else if (outcome?.started.length === 0 && outcome.left.length === 0)
      setAfter({ line: 'Nothing new to start', refused: false });
    else onClose();
  };

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Accept Plan"
      size="md"
      actions={
        <>
          {after?.refused === true ? (
            <ScrollArea.Autosize mah={72} maw={320} type="auto">
              <Text size="xs" c="red" role="alert">
                {after.line}
              </Text>
            </ScrollArea.Autosize>
          ) : null}
          {beside.length === 0 || after !== null ? null : (
            <ScrollArea.Autosize mah={72} maw={320} type="auto">
              <Stack gap={0} role="alert">
                {beside.map((line) => (
                  <Text key={line} size="xs" c="red">
                    {line}
                  </Text>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
          {after === null ? (
            <>
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant={startsAny ? 'default' : 'filled'}
                loading={pending}
                disabled={chosen.length === 0 || unmarked.length > 0}
                onClick={() => {
                  void convert(false);
                }}
              >
                Accept
              </Button>
              {startsAny ? (
                <Button
                  loading={pending}
                  disabled={chosen.length === 0 || unmarked.length > 0 || counts === undefined}
                  onClick={() => {
                    void convert(true);
                  }}
                >
                  Accept and Start
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant={after.goalId === undefined ? 'filled' : 'default'} onClick={onClose}>
                Done
              </Button>
              {after.goalId === undefined ? null : (
                <Button
                  onClick={() => {
                    const goal = after.goalId;
                    onClose();
                    if (goal !== undefined) void navigate({ to: '/goals', search: { goal } });
                  }}
                >
                  Open Goal
                </Button>
              )}
            </>
          )}
        </>
      }
    >
      <Stack gap="md">
        {/* Said only when Accept and Start would not start everything at once. */}
        {counts === undefined ||
        (counts.forLane + counts.forOthers === 0 && counts.stay.length === 0) ? null : (
          <Stack gap={2}>
            <Text size="sm" c="dimmed" role="status">
              {`Accept and Start: ${startCountsLine(counts)}`}
            </Text>
            {counts.stay.map((t, i) => (
              <Text key={`${String(i)}-${t.title}`} size="xs" c="dimmed">
                {`${t.title} stays on the Board: ${t.why}`}
              </Text>
            ))}
          </Stack>
        )}
        {after === null || after.refused ? null : (
          <Text size="sm" role="status">
            {after.line}
          </Text>
        )}
        {arrived === 0 ? null : (
          <Text size="sm" c="dimmed" role="status">
            {`${String(arrived)} new since you opened this`}
          </Text>
        )}
        {rehearsing ? (
          <Text size="sm" c="dimmed" role="status">
            {`Rehearsing ${String(rehearsingCount)} ${rehearsingCount === 1 ? 'task' : 'tasks'}…`}
          </Text>
        ) : null}
        {warnings.length === 0 ? null : (
          <Stack gap={2} aria-label="Before you accept">
            {warnings.map((line, index) => (
              <Text key={line} size="xs" c="dimmed">
                <IconAlertTriangle
                  size={14}
                  stroke={1.5}
                  color="var(--mantine-color-yellow-filled)"
                  aria-hidden="true"
                  style={{ verticalAlign: '-2px' }}
                />{' '}
                {line}
                {/* Read Them ends the last warning's line. */}
                {index !== warnings.length - 1 ||
                withNotes === undefined ||
                onReadNotes === undefined ? null : (
                  <>
                    {' · '}
                    <Anchor
                      component="button"
                      type="button"
                      fz="xs"
                      onClick={() => {
                        onReadNotes(withNotes.id);
                      }}
                    >
                      Read Them
                    </Anchor>
                  </>
                )}
              </Text>
            ))}
          </Stack>
        )}
        {cutting ? (
          <Stack gap="xs" role="group" aria-label="Your cut">
            <Text size="sm">
              {`This Plan has ${String(milestones.length)} milestones. Mark each one before any task is made. Only the needed ones become tasks; the rest keep their outline on the Plan.`}
            </Text>
            {milestones.map((row) => (
              <Radio.Group
                key={row.id}
                label={proposalTitle(row)}
                value={marks.get(row.id) ?? ''}
                onChange={(value) => {
                  const mark = MARKS.find((m) => m.value === value);
                  if (mark === undefined) return;
                  setMarks(new Map(marks).set(row.id, mark.value));
                }}
              >
                <Group gap="md" mt={4}>
                  {MARKS.map((mark) => (
                    <Radio key={mark.value} value={mark.value} label={mark.label} />
                  ))}
                </Group>
              </Radio.Group>
            ))}
            {unmarked.length === 0 ? null : (
              <Text size="xs" c="dimmed">
                {`${String(unmarked.length)} not marked yet`}
              </Text>
            )}
          </Stack>
        ) : null}
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing is waiting to be accepted.
          </Text>
        ) : (
          <Stack gap="xs">
            {/* Ticks only when there is a choice to make: one row is simply what Accept takes. */}
            {listed.length === 1 && rows.length === 1 ? null : (
              <Text size="xs" fw={600} c="dimmed">
                Choose What to Accept
              </Text>
            )}
            {listed.map((row) =>
              listed.length === 1 && rows.length === 1 ? (
                <div key={row.id}>
                  <Text size="sm">{proposalTitle(row)}</Text>
                  <Text size="xs" c="dimmed">
                    {destination(row)}
                  </Text>
                </div>
              ) : (
                <div key={row.id}>
                  <Checkbox
                    checked={!unticked.has(row.id)}
                    onChange={(event) => {
                      const next = new Set(unticked);
                      if (event.currentTarget.checked) next.delete(row.id);
                      else next.add(row.id);
                      setUnticked(next);
                    }}
                    label={proposalTitle(row)}
                    description={destination(row)}
                  />
                </div>
              ),
            )}
          </Stack>
        )}
        {rows.length === 0 || after !== null ? null : (
          <Text size="xs" c="dimmed">
            {startsAny
              ? 'Accept puts it on the Board and starts nothing. Accept and Start also starts the work now.'
              : 'Accept puts it on the Board. Nothing is ready to start yet.'}
          </Text>
        )}
      </Stack>
    </FormModal>
  );
}
