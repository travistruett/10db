import { BatchId, InboxKind, type InboxItemDto } from '@10db/contracts';
import { Alert, Anchor, Button, Group, Stack } from '@mantine/core';
import { useAbandonBatch, useShipBatch } from '../../daemon/queries';

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

/** A not-shipped card's step log and, when it offers them, Retry and Abandon of its batch; either dismisses the card once done. */
export function BatchCardActions({
  item,
  onDone,
}: {
  readonly item: InboxItemDto;
  readonly onDone: () => void;
}) {
  const ship = useShipBatch();
  const abandon = useAbandonBatch();
  const log = stepLog(item);
  const offer = actionBatch(item);
  if (log === null && offer === null) return null;
  const error = ship.error ?? abandon.error;
  return (
    <Stack gap="xs">
      {log === null ? null : (
        <Anchor size="sm" href={`file://${log}`} title={log}>
          Open the step log
        </Anchor>
      )}
      {offer === null ? null : (
        <Group gap="xs">
          {offer.retry ? (
            <Button
              size="xs"
              loading={ship.isPending}
              onClick={() => {
                abandon.reset();
                ship.mutate(offer.batchId, { onSuccess: onDone });
              }}
            >
              Retry
            </Button>
          ) : null}
          {offer.abandon ? (
            <Button
              size="xs"
              variant="default"
              color="red"
              loading={abandon.isPending}
              onClick={() => {
                ship.reset();
                abandon.mutate(offer.batchId, { onSuccess: onDone });
              }}
            >
              Abandon
            </Button>
          ) : null}
        </Group>
      )}
      {error ? (
        <Alert color="red" variant="light">
          {error.message}
        </Alert>
      ) : null}
    </Stack>
  );
}
