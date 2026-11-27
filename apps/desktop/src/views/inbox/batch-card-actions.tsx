import { BatchId, CARD_CLOSES_ITSELF, InboxKind, type InboxItemDto } from '@10db/contracts';
import { Anchor } from '@mantine/core';
import { useAbandonBatch, useShipBatch } from '../../daemon/queries';
import type { BarButton } from './card-actions';

/**
 * The gate step log a not-shipped card names (`detail.logPath`), as a file:// link with the path as its
 * tooltip. Only an absolute path: the daemon's text is not trusted to be anything else.
 */
function stepLog(item: InboxItemDto): string | null {
  if (item.kind !== InboxKind.Flag) return null;
  const path = item.detail?.['logPath'];
  return typeof path === 'string' && path.startsWith('/') ? path : null;
}

/** The batch a card offers Retry and Abandon for (`detail.actions`), or null when it offers neither. */
function actionBatch(
  item: InboxItemDto,
): { batchId: BatchId; retry: boolean; abandon: boolean } | null {
  if (item.kind !== InboxKind.Flag) return null;
  const actions = item.detail?.['actions'];
  const batchId = BatchId.safeParse(item.detail?.['batchId']);
  if (!Array.isArray(actions) || !batchId.success) return null;
  const retry = actions.includes('retry');
  const abandon = actions.includes('abandon');
  return retry || abandon ? { batchId: batchId.data, retry, abandon } : null;
}

/** A not-shipped card's gate step log, opened as a file. */
export function StepLogLink({ item }: { readonly item: InboxItemDto }) {
  const log = stepLog(item);
  if (log === null) return null;
  return (
    <Anchor size="sm" href={`file://${log}`} title={log}>
      Open the step log
    </Anchor>
  );
}

/**
 * Retry and Abandon of a not-shipped card's batch, when it offers them, as buttons for the card's bar, with
 * the error either met. Either dismisses a card that is answered by a dismiss; a card that closes itself
 * leaves by its closer (the batch ships) or by the withdrawal an abandon makes, and is never dismissed here.
 */
export function useBatchActions(
  item: InboxItemDto,
  onDone: () => void,
): {
  readonly buttons: readonly BarButton[];
  readonly error: string | null;
  /** Which answers the card offers, for the line that says what each does. */
  readonly offers: { readonly retry: boolean; readonly abandon: boolean };
} {
  const ship = useShipBatch();
  const abandon = useAbandonBatch();
  const done = item.detail?.[CARD_CLOSES_ITSELF] === true ? () => undefined : onDone;
  const offer = actionBatch(item);
  if (offer === null) return { buttons: [], error: null, offers: { retry: false, abandon: false } };
  const buttons: BarButton[] = [];
  if (offer.retry)
    buttons.push({
      label: 'Retry',
      loading: ship.isPending,
      onClick: () => {
        abandon.reset();
        ship.mutate(offer.batchId, { onSuccess: done });
      },
    });
  if (offer.abandon)
    buttons.push({
      label: 'Abandon',
      color: 'red',
      loading: abandon.isPending,
      onClick: () => {
        ship.reset();
        abandon.mutate(offer.batchId, { onSuccess: done });
      },
    });
  return {
    buttons,
    error: (ship.error ?? abandon.error)?.message ?? null,
    offers: { retry: offer.retry, abandon: offer.abandon },
  };
}
