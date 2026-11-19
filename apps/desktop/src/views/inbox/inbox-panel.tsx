import { InboxListState } from '@10db/contracts';
import { Box, Group, SegmentedControl, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { useInboxCount } from '../../daemon/inbox-queries';
import { useSlackConnection } from '../../daemon/people';
import { Panel } from '../../shell/panel';
import { useOpenInboxCount } from './inbox-count';
import { InboxFilterMenu } from './inbox-filter-menu';
import { withFilter, type InboxSearch } from './inbox-search';
import { InboxSearchField } from './inbox-search-field';

/** The largest count the switch shows whole. */
const SWITCH_COUNT_CAP = 99;

/**
 * A state's count in the switch: a plain dim number beside its label, lighter than a pill, since the
 * segment's own fill already frames it.
 */
function SwitchCount({ count }: { readonly count: number }) {
  return (
    <Text span fz={11} fw={500} c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {count > SWITCH_COUNT_CAP ? `${String(SWITCH_COUNT_CAP)}+` : count}
    </Text>
  );
}

const LIST_STATES: readonly InboxListState[] = Object.values(InboxListState);

function stateOf(value: string): InboxListState | null {
  return LIST_STATES.find((state) => state === value) ?? null;
}

/**
 * The Inbox's panel (spec §1.3 "Head", §4.1 "The panel's head"): the section's name with the filter, then a
 * switch between Open, Waiting and Resolved with their counts, then the search within the state chosen, then the
 * list under them. The list is drawn into
 * `onListHost`'s element by whichever state has rows, so the switch stays mounted as the state changes. The
 * notices that ask nothing are the Factory's Activity drawer, not an Inbox list.
 */
export function InboxPanel({
  state,
  search,
  onState,
  onSearch,
  onListHost,
}: {
  readonly state: InboxListState;
  readonly search: InboxSearch;
  readonly onState: (state: InboxListState) => void;
  /** The search changed: its text (the field writes it after a pause) or a filter. */
  readonly onSearch: (next: InboxSearch) => void;
  readonly onListHost: (host: HTMLElement | null) => void;
}): ReactNode {
  const open = useOpenInboxCount();
  const waiting = useInboxCount('waiting');
  const slack = useSlackConnection();
  // Nothing in Waiting needs the builder, so its count is neutral, and it is told only while Slack can fill it.
  const showWaiting = slack.data?.state === 'connected' && waiting !== undefined && waiting > 0;
  return (
    <Panel
      section="inbox"
      title="Inbox"
      controls={<InboxFilterMenu state={state} search={search} onChange={onSearch} />}
    >
      <Box
        component="section"
        aria-label="Inbox panel"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <Box pt={4}>
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
                  <Group gap={5} wrap="nowrap" justify="center" align="baseline">
                    Open
                    {open > 0 ? <SwitchCount count={open} /> : null}
                  </Group>
                ),
              },
              {
                value: InboxListState.Waiting,
                label: (
                  <Group gap={5} wrap="nowrap" justify="center" align="baseline">
                    Waiting
                    {showWaiting ? <SwitchCount count={waiting} /> : null}
                  </Group>
                ),
              },
              { value: InboxListState.Resolved, label: 'Resolved' },
            ]}
          />
        </Box>
        <Box pt={8} pb={12}>
          <InboxSearchField
            query={search.q}
            onQuery={(q) => {
              onSearch(withFilter(search, 'q', q ?? null));
            }}
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
