import {
  InboxKind,
  InboxListState,
  InboxOutcome,
  inboxOutcome,
  isDismissable,
  type InboxItemDto,
} from '@10db/contracts';
import { Button, Text } from '@mantine/core';
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

/** The short word a row's first line starts with, by what the card is. */
export const KIND_TAGS: Record<InboxKind, string> = {
  [InboxKind.Question]: 'ASK',
  [InboxKind.Permission]: 'ALLOW',
  [InboxKind.Proposal]: 'PROPOSAL',
  [InboxKind.Review]: 'REVIEW',
  [InboxKind.Flag]: 'FLAG',
  [InboxKind.Check]: 'CHECK',
  [InboxKind.Plan]: 'PLAN',
  [InboxKind.PlaybookMoveReport]: 'SETTINGS',
};

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

function Lines({
  tag,
  tone,
  title,
  count,
  age,
  second,
  failure,
  dismiss,
}: {
  readonly tag: string;
  readonly tone: 'open' | 'quiet';
  readonly title: string;
  readonly count: number;
  readonly age: string | null;
  readonly second: ReactNode;
  readonly failure: string | null;
  readonly dismiss: ReactNode;
}) {
  return (
    <div className={classes['item']}>
      <div className={classes['line']}>
        <Text
          fz={10}
          fw={700}
          c={tone === 'open' ? 'var(--mantine-color-yellow-text)' : 'dimmed'}
          style={{ flexShrink: 0, letterSpacing: '0.04em' }}
        >
          {tag}
        </Text>
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
      {dismiss}
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
 * The two lines of a row in the panel (spec §4.1 "A row"): the kind, the title, how many and how long ago,
 * then the project and what the card is about. A dismissable row offers Dismiss on hover and on focus.
 */
export function InboxRowItem({
  row,
  state,
  now,
  failure,
  pending,
  onDismiss,
}: {
  readonly row: OpenRow;
  readonly state: InboxListState;
  readonly now: number;
  /** Why this row's last dismiss failed, shown on the row. */
  readonly failure: string | null;
  readonly pending: boolean;
  readonly onDismiss: (row: InboxRow) => void;
}) {
  const tone = state === InboxListState.Open ? 'open' : 'quiet';
  if (row.kind === OpenRowKind.System) {
    const { title, body } = cardText(row.card);
    return (
      <Lines
        tag="10db"
        tone={tone}
        title={title}
        count={1}
        age={null}
        second={
          <Text fz={12} c="dimmed" truncate style={{ minWidth: 0 }}>
            {firstLine(body)}
          </Text>
        }
        failure={null}
        dismiss={null}
      />
    );
  }
  const items = row.row.items;
  const [first] = items;
  const pass = row.row.passId !== null;
  const dismissable = state === InboxListState.Open && !pass && isDismissable(first);
  const verb = items.length > 1 ? 'Dismiss All' : 'Dismiss';
  return (
    <Lines
      tag={KIND_TAGS[first.kind]}
      tone={tone}
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
      dismiss={
        dismissable ? (
          <Button
            className={classes['dismiss']}
            size="compact-xs"
            variant="default"
            loading={pending}
            aria-label={`${verb}: ${first.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onDismiss(row.row);
            }}
          >
            {verb}
          </Button>
        ) : null
      }
    />
  );
}
