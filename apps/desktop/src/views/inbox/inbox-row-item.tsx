import {
  InboxListState,
  InboxOutcome,
  inboxOutcome,
  isDismissable,
  Urgency,
  type InboxItemDto,
} from '@10db/contracts';
import { Badge, Button, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import type { InboxRow } from '../../daemon/inbox-queries';
import { ProjectLabel } from '../../shell/project-label';
import { shortAgo } from '../factory/short-ago';
import classes from './inbox-row-item.module.css';
import { passReadyTitle } from './pass-ready-row';
import { answerWords } from './resolved-detail';
import { SessionBadge, useSessionOfCard } from './session-card-link';
import { cardText } from './system-card-list';
import type { SystemCard } from './system-cards';
import { recipientsOf } from './waiting-row';

/** The words for how a resolved card closed, on its row and in the filter. */
export const OUTCOME_LABELS: Readonly<Record<InboxOutcome, string>> = {
  [InboxOutcome.Answered]: 'Answered',
  [InboxOutcome.TenDb]: 'Closed by 10db',
  [InboxOutcome.Slack]: 'Slack Answer',
};

export const OpenRowKind = { System: 'system', Inbox: 'inbox' } as const;
export type OpenRowKind = (typeof OpenRowKind)[keyof typeof OpenRowKind];

/** A row of Open: one of 10db's own cards, or a row the daemon sent. `key` is what selection follows. */
export type OpenRow =
  | { readonly kind: typeof OpenRowKind.System; readonly key: string; readonly card: SystemCard }
  | { readonly kind: typeof OpenRowKind.Inbox; readonly key: string; readonly row: InboxRow };

/** The row of a system card; its key never collides with a card's id or a group's key. */
export function systemRow(card: SystemCard): OpenRow {
  return { kind: OpenRowKind.System, key: `system:${card.key}`, card };
}

export function inboxRowOf(row: InboxRow): OpenRow {
  return { kind: OpenRowKind.Inbox, key: row.key, row };
}

const firstLine = (text: string): string => text.split('\n')[0] ?? '';

export function Lines({
  mark = null,
  title,
  count,
  age,
  second,
  failure,
}: {
  /** A mark before the title, where it tells rows apart (a warning in Activity); most rows have none. */
  readonly mark?: ReactNode;
  readonly title: string;
  readonly count: number;
  readonly age: string | null;
  readonly second: ReactNode;
  readonly failure: string | null;
}) {
  return (
    <div className={classes['item']}>
      <div className={classes['line']}>
        {mark}
        <Text
          fz={13}
          fw={500}
          c="var(--mantine-color-bright)"
          truncate
          title={title}
          style={{ minWidth: 0 }}
        >
          {title}
        </Text>
        {count > 1 ? (
          <Text fz={11} c="dimmed" style={{ flexShrink: 0 }}>
            {`×${String(count)}`}
          </Text>
        ) : null}
        {age === null ? null : (
          <Text
            fz={11}
            c="dimmed"
            style={{ flexShrink: 0, marginLeft: 'auto', whiteSpace: 'nowrap' }}
          >
            {age}
          </Text>
        )}
      </div>
      <div className={classes['line']}>
        {failure === null ? (
          second
        ) : (
          <Text fz={12} c="red" truncate style={{ minWidth: 0 }}>
            {failure}
          </Text>
        )}
      </div>
    </div>
  );
}

/** What a Waiting or Resolved row's second line says after the project. */
function closedLine(state: InboxListState, item: InboxItemDto, now: number): string {
  if (state === InboxListState.Waiting) {
    const sent = item.send?.sentAt;
    return `Waiting on ${recipientsOf(item)}${sent == null ? '' : ` · ${shortAgo(sent, now)}`}`;
  }
  const choice = item.answer?.choice;
  const answer =
    choice === undefined || choice === 'dismissed' ? 'Dismissed' : answerWords(item, choice);
  return `${OUTCOME_LABELS[inboxOutcome(item)]} · ${answer}`;
}

/** How long ago a row's card happened: Open's arrived, Waiting's was sent, Resolved's closed. */
function rowAge(state: InboxListState, item: InboxItemDto, now: number): string {
  if (state === InboxListState.Waiting && item.send?.sentAt != null)
    return shortAgo(item.send.sentAt, now);
  return shortAgo(state === InboxListState.Resolved ? item.updatedAt : item.createdAt, now);
}

/**
 * A High marker on an Open row: Open lists the most urgent first, so it says why a row sits above
 * a newer one. Normal and Low rows are the common case and carry none.
 */
function UrgencyMark({ urgency }: { readonly urgency: Urgency }) {
  if (urgency !== Urgency.High) return null;
  return (
    <Badge size="xs" color="red" variant="light" style={{ flexShrink: 0 }}>
      High
    </Badge>
  );
}

/** What a chat's card says in place of its body: the session that raised it. */
function SessionLine({ item }: { readonly item: InboxItemDto }) {
  const session = useSessionOfCard(item);
  if (session === null)
    return (
      <Text fz={12} c="dimmed" truncate style={{ minWidth: 0 }}>
        {firstLine(item.body)}
      </Text>
    );
  return <SessionBadge chat={session} />;
}

/**
 * The two lines of a row in the panel (spec §4.1 "A row"): the title, how many and how long ago,
 * then the project and what the card is about.
 */
export function InboxRowItem({
  row,
  state,
  now,
  failure,
}: {
  readonly row: OpenRow;
  readonly state: InboxListState;
  readonly now: number;
  /** Why this row's last dismiss failed, shown on the row. */
  readonly failure: string | null;
}) {
  if (row.kind === OpenRowKind.System) {
    const { title, body } = cardText(row.card);
    return (
      <Lines
        title={title}
        count={1}
        age={null}
        second={
          <Text fz={12} c="dimmed" truncate style={{ minWidth: 0 }}>
            {firstLine(body)}
          </Text>
        }
        failure={null}
      />
    );
  }
  const items = row.row.items;
  const [first] = items;
  const pass = row.row.passId !== null;
  return (
    <Lines
      mark={state === InboxListState.Open ? <UrgencyMark urgency={first.urgency} /> : null}
      title={first.title}
      count={pass ? 1 : items.length}
      age={rowAge(state, first, now)}
      second={
        <>
          <ProjectLabel projectId={first.projectId} />
          {state !== InboxListState.Open ? (
            <Text fz={12} c="dimmed" truncate style={{ minWidth: 0 }}>
              {closedLine(state, first, now)}
            </Text>
          ) : pass ? (
            <Text fz={12} c="dimmed" truncate style={{ minWidth: 0 }}>
              {passReadyTitle(items.length)}
            </Text>
          ) : (
            <SessionLine item={first} />
          )}
        </>
      }
      failure={failure}
    />
  );
}

/**
 * A dismissable row's Dismiss, drawn by the list beside the row's option. It is a flag row of Open that is not a
 * pass's; any other row has none.
 */
export function InboxRowDismiss({
  row,
  state,
  pending,
  onDismiss,
}: {
  readonly row: OpenRow;
  readonly state: InboxListState;
  readonly pending: boolean;
  readonly onDismiss: (row: InboxRow) => void;
}) {
  if (row.kind !== OpenRowKind.Inbox) return null;
  const items = row.row.items;
  const [first] = items;
  if (state !== InboxListState.Open || row.row.passId !== null || !isDismissable(first))
    return null;
  const verb = items.length > 1 ? 'Dismiss All' : 'Dismiss';
  return (
    <Button
      size="compact-xs"
      variant="default"
      loading={pending}
      aria-label={`${verb}: ${first.title}`}
      onClick={() => {
        onDismiss(row.row);
      }}
    >
      {verb}
    </Button>
  );
}
