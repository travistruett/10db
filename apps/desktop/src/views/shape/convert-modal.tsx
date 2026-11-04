import type { ShapeProposalDto, ShapeProposalId, ShapeViewDto } from '@10db/contracts';
import { Button, Checkbox, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import type { ConvertShapeResult } from '../../daemon/shape-queries';
import { FormModal } from '../../shell/form-modal';
import { destination, proposalTitle } from './proposal-text';
import { isConverted } from './proposed-groups';
import { ReviewLines } from './review-notes';
import { convertWarnings, rowReview } from './review-lines';

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
  /** Claude is answering now: Convert waits, or the builder stops the turn. */
  readonly answering: boolean;
  readonly pending: boolean;
  /** Every reason the last Convert was refused; nothing was written. */
  readonly refusals: readonly string[];
  /** The daemon's words when the request itself failed. */
  readonly failure: string | null;
  readonly onConvert: (
    ids: readonly ShapeProposalId[],
    options?: { readonly interrupt: true },
  ) => Promise<ConvertShapeResult | undefined>;
  readonly onStop: () => void;
  /** Opening the modal with a task nobody has rehearsed asks for it (spec §7). */
  readonly onRehearse: (ids: readonly ShapeProposalId[]) => void;
}

/**
 * A form modal with a checkbox per pending proposal and where it goes, the line that says nothing
 * starts, and the primary Convert n. Opening it with an unrehearsed task starts a rehearsal turn;
 * Convert Anyway stops that turn and converts. Open questions and findings warn and never block.
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
  pending,
  refusals,
  failure,
  onConvert,
  onStop,
  onRehearse,
}: ConvertModalProps) {
  const [unticked, setUnticked] = useState<ReadonlySet<ShapeProposalId>>(new Set());
  const chosen = rows.filter((r) => !unticked.has(r.id));
  const beside = refusals.length > 0 ? refusals : failure === null ? [] : [failure];
  const rehearsing = view.turn.rehearsing;
  const rehearsingCount = chosen
    .flatMap((r) => rowReview(view, r).tasks)
    .filter((t) => t.state === 'rehearsing').length;
  const warnings = convertWarnings(view, chosen, rehearsing);

  // Once per opening: a task with no mark at its current content gets a rehearsal turn.
  const asked = useRef(false);
  const unread = unrehearsedRows(view, rows);
  useEffect(() => {
    if (!opened) {
      asked.current = false;
      return;
    }
    if (asked.current || rehearsing || unread.length === 0) return;
    asked.current = true;
    onRehearse(unread);
  }, [opened, rehearsing, unread, onRehearse]);

  const convert = async (interrupt: boolean): Promise<void> => {
    const ids = chosen.map((r) => r.id);
    const result = await (interrupt ? onConvert(ids, { interrupt: true }) : onConvert(ids));
    if (result?.kind === 'converted') onClose();
  };

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Convert"
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
          {rehearsing ? (
            <Button
              variant="default"
              loading={pending}
              disabled={chosen.length === 0}
              onClick={() => {
                void convert(true);
              }}
            >
              Convert Anyway
            </Button>
          ) : null}
          <Button
            loading={pending}
            disabled={chosen.length === 0 || answering}
            onClick={() => {
              void convert(false);
            }}
          >
            {`Convert ${String(chosen.length)}`}
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
        ) : answering ? (
          <Group gap="sm" wrap="nowrap">
            <Text size="sm" c="dimmed">
              Claude is still answering. Stop it, or wait for it to finish.
            </Text>
            <Button variant="default" size="xs" onClick={onStop}>
              Stop
            </Button>
          </Group>
        ) : null}
        {warnings.length === 0 ? null : (
          <Stack gap={2} aria-label="Before you convert">
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
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing is waiting to be converted.
          </Text>
        ) : (
          <Stack gap="xs">
            {rows.map((row) => (
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
                  <ReviewLines review={rowReview(view, row)} showRehearsal pl={28} />
                ) : null}
              </div>
            ))}
          </Stack>
        )}
      </Stack>
    </FormModal>
  );
}
