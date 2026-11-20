import { CloseStep, PassState, type InboxItemDto, type PassViewDto } from '@10db/contracts';
import { Button, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { FormModal } from '../../shell/form-modal';
import { PageStatus, pageStatus } from './page-status';
import { passTitle } from './pass-title';
import { medianTurnMinutes } from './timing';

export interface AbandonModalProps {
  readonly view: PassViewDto;
  /** The open Inbox items, which a page's status reads. */
  readonly inbox: readonly InboxItemDto[];
  /** Now, in epoch milliseconds. */
  readonly now: number;
  readonly onClose: () => void;
  /** Abandons the pass: its route in the daemon. */
  readonly abandon: () => Promise<unknown>;
}

/**
 * What a close under way means for an Abandon: it stops the close, until the close has begun moving
 * the folder's branch (D23 step 2); null while the pass is not closing.
 */
function closingLine(
  view: PassViewDto,
): { readonly line: string; readonly refused: boolean } | null {
  if (view.pass.state !== PassState.Closing) return null;
  return view.closeStep !== null && view.closeStep >= CloseStep.FastForwarded
    ? { line: 'It is landing now, so it can no longer be discarded.', refused: true }
    : { line: 'Finishing stops where it is; what has landed stays.', refused: false };
}

/**
 * Discard Pass's confirm, the daemon's Abandon (Workbench spec §5.4): names, by label, every page whose
 * changes it deletes, its files going back to how they were before the pass, and every committed page,
 * which stays. From a close, it says the close stops, and refuses once the close is landing.
 */
export function AbandonModal({ view, inbox, now, onClose, abandon }: AbandonModalProps) {
  const leaving = useMutation({ mutationFn: () => abandon(), onSuccess: onClose });
  const clock = { now, medianTurnMinutes: medianTurnMinutes(view.turns) };
  const signedOff = (page: PassViewDto['pages'][number]) =>
    pageStatus(page, inbox, clock, view).status === PageStatus.SignedOff;
  const discards = view.pages.filter((page) => !signedOff(page)).map((page) => page.label);
  const stays = view.pages.filter(signedOff).map((page) => page.label);
  const closing = closingLine(view);
  return (
    <FormModal
      opened
      onClose={onClose}
      title="Discard Pass"
      size="md"
      error={leaving.error?.message ?? null}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="red"
            loading={leaving.isPending}
            disabled={closing?.refused === true}
            onClick={() => {
              leaving.mutate();
            }}
          >
            Discard Pass
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <Text size="sm">{`Discard the whole pass (${passTitle(view.pages, view.pass.name)})? It ends, and turns that are working stop.`}</Text>
        {closing === null ? null : (
          <Text size="sm" {...(closing.refused ? { c: 'red' } : {})}>
            {closing.line}
          </Text>
        )}
        {discards.length > 0 ? (
          <>
            <Text size="sm">{`Discards: ${discards.join(', ')} (their changes are deleted).`}</Text>
            <Text size="sm" c="dimmed">
              Tasks 10db made for these pages are removed; tasks you brought in from the Board go
              back there.
            </Text>
          </>
        ) : null}
        {stays.length > 0 ? (
          <Text size="sm">{`Stays: ${stays.join(', ')} (committed).`}</Text>
        ) : null}
      </Stack>
    </FormModal>
  );
}
