import {
  MILESTONES_BEFORE_CUT,
  MilestoneMark,
  type MilestoneCut,
  type ShapeProposalDto,
  type ShapeProposalId,
  type ShapeStartCountsDto,
  type ShapeViewDto,
} from '@10db/contracts';
import { Button, Checkbox, Group, Radio, ScrollArea, Stack, Switch, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import { useStartCounts, type ConvertShapeResult } from '../../../daemon/shape-queries';
import { FormModal } from '../../../shell/form-modal';
import { destination, proposalTitle } from './proposal-text';
import { isConverted } from './proposed-groups';
import { ReviewLines } from './review-notes';
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

/** The counts line under the Start switch; a part that is zero drops out. */
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
  readonly onConvert: (
    ids: readonly ShapeProposalId[],
    options?: { readonly cut?: readonly MilestoneCut[]; readonly start?: boolean },
  ) => Promise<ConvertShapeResult | undefined>;
}

/**
 * A form modal with a checkbox per pending proposal and where it goes, a Start switch (off: nothing
 * starts; on: what would start, counted), and the primary Accept n or Accept and Start n. Accept never
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
  onConvert,
}: ConvertModalProps) {
  const [unticked, setUnticked] = useState<ReadonlySet<ShapeProposalId>>(new Set());
  // Start: the confirm says what starts, and Convert also starts it. Every opening begins off.
  const [start, setStart] = useState(false);
  const [marks, setMarks] = useState<ReadonlyMap<ShapeProposalId, MilestoneMark>>(new Map());
  // The rows there were when the modal opened. A round that lands under it adds rows, ticked, and the
  // builder's unticks and marks stay as they were.
  const [openedWith, setOpenedWith] = useState<ReadonlySet<ShapeProposalId> | null>(null);
  if (opened && openedWith === null) setOpenedWith(new Set(rows.map((r) => r.id)));
  if (!opened && openedWith !== null) {
    setOpenedWith(null);
    setStart(false);
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
    opened && start,
  ).data;
  // Nothing in what is ticked would start: the button is a plain Accept and sends no start.
  const startsAny = counts === undefined || counts.now + counts.forLane + counts.forOthers > 0;
  const starting = start && startsAny;
  // After an Accept the start could not follow, or had nothing new: the modal stays until Done.
  const [after, setAfter] = useState<{ readonly line: string; readonly refused: boolean } | null>(
    null,
  );
  if (!opened && after !== null) setAfter(null);
  const beside = refusals.length > 0 ? refusals : failure === null ? [] : [failure];
  const rehearsing = view.turn.rehearsing;
  const rehearsingCount = chosen
    .flatMap((r) => rowReview(view, r).tasks)
    .filter((t) => t.state === 'rehearsing').length;
  const warnings = convertWarnings(view, chosen, rehearsing);

  const convert = async (): Promise<void> => {
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
    if (outcome?.refused != null)
      setAfter({ line: `Accepted. The start was refused: ${outcome.refused}`, refused: true });
    else if (outcome?.started.length === 0 && outcome.left.length === 0)
      setAfter({ line: 'Nothing new to start', refused: false });
    else onClose();
  };

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Accept"
      size="lg"
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
                loading={pending}
                disabled={chosen.length === 0 || unmarked.length > 0}
                onClick={() => {
                  void convert();
                }}
              >
                {`${starting ? 'Accept and Start' : 'Accept'} ${String(chosen.length)}`}
              </Button>
            </>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )}
        </>
      }
    >
      <Stack gap="md">
        <Stack gap={4}>
          <Switch
            label="Start the tasks that are ready"
            checked={start}
            disabled={after !== null}
            onChange={(event) => {
              setStart(event.currentTarget.checked);
            }}
          />
          <Text size="sm" c="dimmed" pl={48} role="status">
            {!start
              ? 'Nothing starts. Tasks wait on the Board.'
              : counts === undefined
                ? 'Counting what would start…'
                : startsAny
                  ? startCountsLine(counts)
                  : 'Nothing to start'}
          </Text>
          {start
            ? counts?.stay.map((t, i) => (
                <Text key={`${String(i)}-${t.title}`} size="xs" c="dimmed" pl={48}>
                  {`${t.title} stays on the Board: ${t.why}`}
                </Text>
              ))
            : null}
        </Stack>
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
            {warnings.map((line) => (
              <Text key={line} size="xs" c="dimmed">
                <IconAlertTriangle
                  size={14}
                  stroke={1.5}
                  aria-hidden="true"
                  style={{ verticalAlign: '-2px' }}
                />{' '}
                {line}
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
            {listed.map((row) => (
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
                {row.kind === 'goal' || row.kind === 'task' ? (
                  <ReviewLines review={rowReview(view, row)} pl={28} />
                ) : null}
              </div>
            ))}
          </Stack>
        )}
      </Stack>
    </FormModal>
  );
}
