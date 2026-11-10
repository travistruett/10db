import type { PassId, SharedChoiceKind, TaskId } from '@10db/contracts';
import { Button, Loader, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useTakeOutPreview } from '../../daemon/pass-close-queries';
import { useTakeOutPage } from '../../daemon/pass-queries';
import { FormModal } from '../../shell/form-modal';
import { SharedChoices, sharedChoicesOf } from './shared-choices';

export interface TakeOutModalProps {
  readonly passId: PassId;
  readonly taskId: TaskId;
  /** The page's name. */
  readonly area: string;
  readonly onClose: () => void;
}

/** What a take-out that stopped short says: the page stays, and why. */
function stillChangingLine(area: string, files: readonly string[]): string {
  return `${area} stays in the pass: its files kept changing (${files.join(', ')}). Try again once they settle.`;
}

/**
 * Take Out…'s confirm (Workbench spec §5.4, §7.2): the page leaves the pass, its work kept with its
 * task, and its files go back to how they were before the pass. Its shared changes that have not
 * landed are read first; each is kept, or dropped where Drop is offered.
 */
export function TakeOutModal({ passId, taskId, area, onClose }: TakeOutModalProps) {
  const preview = useTakeOutPreview({ passId, taskId });
  const [chosen, setChosen] = useState<ReadonlyMap<number, SharedChoiceKind>>(new Map());
  const taking = useTakeOutPage();
  const stopped = taking.data?.tookOut === false ? taking.data.stillChanging : null;
  const shared = preview.data?.shared ?? [];
  return (
    <FormModal
      opened
      onClose={onClose}
      title={`Take Out ${area}`}
      size="md"
      error={
        taking.error?.message ??
        preview.error?.message ??
        (stopped === null ? null : stillChangingLine(area, stopped))
      }
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={taking.isPending}
            disabled={preview.data === undefined}
            onClick={() => {
              taking.mutate(
                { passId, taskId, shared: sharedChoicesOf(shared, chosen) },
                {
                  onSuccess: (result) => {
                    if (result.tookOut) onClose();
                  },
                },
              );
            }}
          >
            Take Out
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        <Text size="sm">
          {`Take ${area} out of the pass? A turn that is working stops. Its task keeps the work for its next start, and its files go back to how they were before the pass.`}
        </Text>
        {preview.isPending ? (
          <Loader size="xs" role="status" aria-label="Reading its shared changes" />
        ) : shared.length === 0 ? null : (
          <>
            <Text size="sm">
              Its shared changes that have not landed: keep each for the pages built on it, or drop
              it back to how it was.
            </Text>
            <SharedChoices
              changes={shared}
              chosen={chosen}
              disabled={taking.isPending}
              onChoose={(seq, choice) => {
                setChosen((held) => new Map(held).set(seq, choice));
              }}
            />
          </>
        )}
      </Stack>
    </FormModal>
  );
}
