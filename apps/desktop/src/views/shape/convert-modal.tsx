import type { ShapeProposalDto, ShapeProposalId } from '@10db/contracts';
import { Button, Checkbox, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import type { ConvertShapeResult } from '../../daemon/shape-queries';
import { FormModal } from '../../shell/form-modal';
import { destination, isConvertible, proposalTitle } from './proposal-text';
import { isConverted } from './proposed-groups';

/** The rows Convert can write now: pending ones of a kind it writes. */
export function convertibleRows(proposals: readonly ShapeProposalDto[]): ShapeProposalDto[] {
  return proposals.filter((p) => p.state === 'pending' && isConvertible(p) && !isConverted(p));
}

export interface ConvertModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly rows: readonly ShapeProposalDto[];
  /** Claude is answering now: Convert waits, or the builder stops the turn. */
  readonly answering: boolean;
  readonly pending: boolean;
  /** Every reason the last Convert was refused; nothing was written. */
  readonly refusals: readonly string[];
  /** The daemon's words when the request itself failed. */
  readonly failure: string | null;
  readonly onConvert: (ids: readonly ShapeProposalId[]) => Promise<ConvertShapeResult | undefined>;
  readonly onStop: () => void;
}

/**
 * A form modal with a checkbox per pending proposal and where it goes, the line that says nothing
 * starts, and the primary Convert n. A refusal is listed row by row beside the primary.
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
  answering,
  pending,
  refusals,
  failure,
  onConvert,
  onStop,
}: ConvertModalProps) {
  const [unticked, setUnticked] = useState<ReadonlySet<ShapeProposalId>>(new Set());
  const chosen = rows.filter((r) => !unticked.has(r.id));
  const beside = refusals.length > 0 ? refusals : failure === null ? [] : [failure];

  const convert = async (): Promise<void> => {
    const result = await onConvert(chosen.map((r) => r.id));
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
          <Button
            loading={pending}
            disabled={chosen.length === 0 || answering}
            onClick={() => {
              void convert();
            }}
          >
            {`Convert ${String(chosen.length)}`}
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <Text size="sm">Nothing starts. Tasks wait on the Board.</Text>
        {answering ? (
          <Group gap="sm" wrap="nowrap">
            <Text size="sm" c="dimmed">
              Claude is still answering. Stop it, or wait for it to finish.
            </Text>
            <Button variant="default" size="xs" onClick={onStop}>
              Stop
            </Button>
          </Group>
        ) : null}
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing is waiting to be converted.
          </Text>
        ) : (
          <Stack gap="xs">
            {rows.map((row) => (
              <Checkbox
                key={row.id}
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
            ))}
          </Stack>
        )}
      </Stack>
    </FormModal>
  );
}
