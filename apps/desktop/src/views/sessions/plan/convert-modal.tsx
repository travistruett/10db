import {
  MILESTONES_BEFORE_CUT,
  MilestoneMark,
  type MilestoneCut,
  type ShapeProposalDto,
  type ShapeProposalId,
  type ShapeViewDto,
} from '@10db/contracts';
import { Button, Checkbox, Group, Radio, ScrollArea, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import type { ConvertShapeResult } from '../../../daemon/shape-queries';
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

/** The rows with a task the rehearsal has not read at its current content (spec §7). */
export function unrehearsedRows(
  view: ShapeViewDto,
  rows: readonly ShapeProposalDto[],
): ShapeProposalId[] {
  const unread = new Set(view.rehearsals.filter((r) => !r.rehearsed).map((r) => r.proposalId));
  return rows.filter((r) => unread.has(r.id)).map((r) => r.id);
}

export interface ConvertModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly rows: readonly ShapeProposalDto[];
  /** What the review has to say: ceremony, findings and the rehearsal's marks and questions. */
  readonly view: ShapeViewDto;
  /** A turn is running: opening the modal starts no rehearsal, and Accept never touches the turn. */
  readonly answering: boolean;
  /** The agent's name as the UI shows it. */
  readonly agentLabel: string;
  /**
   * The agent can run the rehearsal's implementer; without it no rehearsal starts and none is offered.
   * Null while that is not known yet: nothing starts and Accept waits.
   */
  readonly rehearses: boolean | null;
  readonly pending: boolean;
  /** Every reason the last Convert was refused; nothing was written. */
  readonly refusals: readonly string[];
  /** The daemon's words when the request itself failed. */
  readonly failure: string | null;
  readonly onConvert: (
    ids: readonly ShapeProposalId[],
    options?: { readonly cut?: readonly MilestoneCut[] },
  ) => Promise<ConvertShapeResult | undefined>;
  /** Opening the modal with a task nobody has rehearsed asks for it (spec §7). */
  readonly onRehearse: (ids: readonly ShapeProposalId[]) => void;
}

/**
 * A form modal with a checkbox per pending proposal and where it goes, the line that says nothing
 * starts, and the primary Accept n. Opening it with an unrehearsed task starts a rehearsal turn when none is running.
 * Accept never stops a turn. Open questions and findings warn and never block.
 */
export function ConvertModal(props: ConvertModalProps) {
  // Keyed on the rows, so a new round starts from "everything ticked" again.
  const key = props.rows.map((r) => r.id).join(',');
  return <ConvertForm key={key} {...props} />;
}

function ConvertForm({
  opened,
  onClose,
  rows,
  view,
  answering,
  agentLabel,
  rehearses,
  pending,
  refusals,
  failure,
  onConvert,
  onRehearse,
}: ConvertModalProps) {
  const [unticked, setUnticked] = useState<ReadonlySet<ShapeProposalId>>(new Set());
  const [marks, setMarks] = useState<ReadonlyMap<ShapeProposalId, MilestoneMark>>(new Map());
  // A Plan with many milestones is cut first: each milestone's mark, not a tick, decides whether it converts.
  const milestones = rows.filter((r) => r.kind === 'goal');
  const cutting = milestones.length > MILESTONES_BEFORE_CUT;
  const unmarked = cutting ? milestones.filter((m) => !marks.has(m.id)) : [];
  const listed = cutting ? rows.filter((r) => r.kind !== 'goal') : rows;
  const chosen = rows.filter((r) =>
    cutting && r.kind === 'goal' ? marks.get(r.id) === MilestoneMark.Needed : !unticked.has(r.id),
  );
  const beside = refusals.length > 0 ? refusals : failure === null ? [] : [failure];
  const rehearsing = view.turn.rehearsing;
  const rehearsingCount = chosen
    .flatMap((r) => rowReview(view, r).tasks)
    .filter((t) => t.state === 'rehearsing').length;
  // An imported Plan's tasks were planned elsewhere, and an agent without subagents can't run the
  // rehearsal: no rehearsal reads them, and they are named once.
  const imported = view.shape.importedAt !== null;
  const unrehearsed = imported || rehearses === false;
  const unrehearsedTasks = unrehearsed ? chosen.flatMap((r) => rowReview(view, r).tasks).length : 0;
  const unrehearsedWhy = imported ? 'Imported tasks' : `Tasks on ${agentLabel}`;
  const warnings = [
    ...(unrehearsedTasks === 0
      ? []
      : [
          `${unrehearsedWhy} aren't rehearsed: ${String(unrehearsedTasks)} ${unrehearsedTasks === 1 ? 'task' : 'tasks'}`,
        ]),
    ...convertWarnings(view, chosen, rehearsing),
  ];

  // Once per opening: a task with no mark at its current content gets a rehearsal turn.
  const asked = useRef(false);
  const unread = unrehearsedRows(view, rows);
  useEffect(() => {
    if (!opened) {
      asked.current = false;
      return;
    }
    if (
      rehearses === null ||
      unrehearsed ||
      asked.current ||
      rehearsing ||
      answering ||
      unread.length === 0
    )
      return;
    asked.current = true;
    onRehearse(unread);
  }, [opened, rehearses, unrehearsed, rehearsing, answering, unread, onRehearse]);

  const convert = async (): Promise<void> => {
    const ids = chosen.map((r) => r.id);
    const cut = cutting
      ? [...marks].map(([proposalId, mark]): MilestoneCut => ({ proposalId, mark }))
      : undefined;
    const result = await (cut === undefined ? onConvert(ids) : onConvert(ids, { cut }));
    if (result?.kind === 'converted') onClose();
  };

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Accept"
      size="lg"
      actions={
        <>
          {beside.length === 0 ? null : (
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
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={pending}
            disabled={
              chosen.length === 0 || unmarked.length > 0 || (rehearses === null && !imported)
            }
            onClick={() => {
              void convert();
            }}
          >
            {`Accept ${String(chosen.length)}`}
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <Text size="sm">Nothing starts. Tasks wait on the Board.</Text>
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
                  <ReviewLines review={rowReview(view, row)} showRehearsal={!unrehearsed} pl={28} />
                ) : null}
              </div>
            ))}
          </Stack>
        )}
      </Stack>
    </FormModal>
  );
}
