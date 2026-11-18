import { InboxListState } from '@10db/contracts';
import { Box, Group, SegmentedControl } from '@mantine/core';
import type { ReactNode } from 'react';
import { useInboxCount } from '../../daemon/inbox-queries';
import { useSlackConnection } from '../../daemon/people';
import { CountBadge, CountTone } from '../../shell/count-badge';
import { Panel } from '../../shell/panel';
import { useOpenInboxCount } from './inbox-count';

const STATES: readonly InboxListState[] = Object.values(InboxListState);

function stateOf(value: string): InboxListState | null {
  return STATES.find((state) => state === value) ?? null;
}

/**
 * The Inbox's panel (spec §1.3 "Head", §4.1 "The panel's head"): the section's name, then a switch between
 * Open, Waiting and Resolved with their counts, then the list under them. The list is drawn into
 * `onListHost`'s element by whichever state has rows, so the switch stays mounted as the state changes.
 */
export function InboxPanel({
  state,
  onState,
  onListHost,
}: {
  readonly state: InboxListState;
  readonly onState: (state: InboxListState) => void;
  readonly onListHost: (host: HTMLElement | null) => void;
}): ReactNode {
  const open = useOpenInboxCount();
  const waiting = useInboxCount('waiting');
  const slack = useSlackConnection();
  // Nothing in Waiting needs the builder, so its count is neutral, and it is told only while Slack can fill it.
  const showWaiting = slack.data?.state === 'connected' && waiting !== undefined && waiting > 0;
  return (
    <Panel section="inbox" title="Inbox">
      <Box
        component="section"
        aria-label="Inbox panel"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <Box px="xs" pt={4} pb={8}>
          <SegmentedControl
            size="xs"
            fullWidth
            aria-label="Inbox state"
            value={state}
            onChange={(value) => {
              const next = stateOf(value);
              if (next !== null) onState(next);
            }}
            data={[
              {
                value: InboxListState.Open,
                label: (
                  <Group gap={6} wrap="nowrap" justify="center">
                    Open
                    {open > 0 ? <CountBadge count={open} tone={CountTone.Attention} /> : null}
                  </Group>
                ),
              },
              {
                value: InboxListState.Waiting,
                label: (
                  <Group gap={6} wrap="nowrap" justify="center">
                    Waiting
                    {showWaiting ? <CountBadge count={waiting} /> : null}
                  </Group>
                ),
              },
              { value: InboxListState.Resolved, label: 'Resolved' },
            ]}
          />
        </Box>
        <div
          ref={onListHost}
          style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        />
      </Box>
    </Panel>
  );
}
