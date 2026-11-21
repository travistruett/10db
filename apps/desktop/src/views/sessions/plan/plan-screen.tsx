import type { ShapeId } from '@10db/contracts';
import { Box } from '@mantine/core';
import { ConversationList } from '../../../conversation';
import { itemEntries } from '../../../conversation/item-entries';
import { useConversationItemsState } from '../../../daemon/conversation-queries';
import { useShapeView } from '../../../daemon/shape-queries';
import { planEventEntry } from './plan-entries';
import { ProposedPane } from './proposed-pane';

/**
 * What a session's `see_screen` draws for the Plan: the conversation beside the panel, read only. It reads
 * the plan and its conversation's items, nothing a render token may not.
 */
export function PlanScreen({ shapeId }: { readonly shapeId: ShapeId }) {
  const query = useShapeView(shapeId);
  const view = query.data;
  const { items } = useConversationItemsState(view?.conversationId ?? null);
  const entries = itemEntries(items, new Map(), {
    sendNow: () => undefined,
    label: 'Agent',
    receipts: false,
    working: false,
    cards: [],
    own: (item) => planEventEntry(item, shapeId),
  });
  return (
    <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' }}>
      <Box style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <ConversationList entries={entries} highlight={null} agentLabel="Agent" />
      </Box>
      <Box
        style={{
          flex: 'none',
          width: 420,
          minHeight: 0,
          borderLeft: '1px solid var(--mantine-color-default-border)',
        }}
      >
        <ProposedPane
          view={view}
          loading={query.isLoading}
          error={query.isError ? query.error.message : null}
          summaryHere
          onWhy={() => undefined}
          onAskForChanges={() => undefined}
        />
      </Box>
    </Box>
  );
}
