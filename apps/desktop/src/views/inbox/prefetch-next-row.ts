import { ChangesScope, InboxKind } from '@10db/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { cardContextQuery } from '../../daemon/inbox-queries';
import { useDaemon } from '../../daemon/provider';
import { workstreamChangesQuery } from '../../daemon/queries';
import { CheckDetail } from './check-card';
import { OpenRowKind, type OpenRow } from './inbox-row-item';

/** A prefetch that fails is read again when its card is shown. */
const noop = (): void => undefined;

/**
 * Reads what the next row's content shows before it is selected, so `j` lands on a card that is
 * already there: a question's last messages, or the changes a check is judged by.
 */
export function usePrefetchNextRow(next: OpenRow | undefined): void {
  const queryClient = useQueryClient();
  const { client } = useDaemon();
  const item = next?.kind === OpenRowKind.Inbox ? next.row.items[0] : null;
  const id = item?.id;
  useEffect(() => {
    if (item === null) return;
    if (item.kind === InboxKind.Question) {
      queryClient.query(cardContextQuery(client, item)).catch(noop);
    } else if (item.kind === InboxKind.Check) {
      const detail = CheckDetail.safeParse(item.detail);
      if (!detail.success) return;
      queryClient
        .query(
          workstreamChangesQuery(
            client,
            item.targets[0]?.workstreamId,
            detail.data.head,
            ChangesScope.All,
          ),
        )
        .catch(noop);
    }
    // Only the next row changing asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, queryClient, client]);
}
