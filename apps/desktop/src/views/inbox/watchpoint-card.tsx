import {
  WatchpointCardDetail,
  WatchpointChoice,
  WatchpointReadVerdict,
  type InboxItemDto,
} from '@10db/contracts';
import { Badge, Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { useWatchpointHits } from '../../daemon/watchpoint-queries';
import { WatchpointFolds, WholeDiff } from '../board/watchpoint-folds';
import { CardActions } from './card-actions';
import { CardSurface } from './card-surface';
import { decisionLine } from './decision-line';
import classes from './inbox-card.module.css';
import { PullRequestLink } from './pull-request-link';
import { useCardAnswer } from './use-card-answer';
import { useViewTaskButton } from './view-task';

export interface WatchpointCardProps {
  readonly item: InboxItemDto;
  /** The kind badge and title, laid out as on every other expanded card. */
  readonly header: ReactNode;
  /** The Send Back note, kept by the Inbox so deselecting the card does not lose it. */
  readonly note: string;
  readonly onNote: (note: string) => void;
  /** Called when the card turned out to be answered elsewhere; without it the card says so itself. */
  readonly onAnsweredElsewhere?: () => void;
  readonly framed?: boolean;
}

/** What the judge made of a watchpoint's hit, in the card's words. */
const VERDICT_WORDS: Readonly<Record<WatchpointReadVerdict, string>> = {
  [WatchpointReadVerdict.Clean]: 'Read as Clean',
  [WatchpointReadVerdict.Finding]: 'Read as a Finding',
  [WatchpointReadVerdict.Doubt]: 'Read With Doubt',
  [WatchpointReadVerdict.Destructive]: 'Read as Destructive',
  [WatchpointReadVerdict.Hold]: 'Set to Hold',
  [WatchpointReadVerdict.Unread]: 'Not Read',
};

/** One line per watchpoint that has a verdict: its label and what the read made of it. */
function Verdicts({ rows }: { readonly rows: WatchpointCardDetail['watchpoints'] }) {
  const shown = rows.flatMap((row) =>
    row.verdict === undefined ? [] : [{ key: row.key, label: row.label, verdict: row.verdict }],
  );
  if (shown.length === 0) return null;
  return (
    <Stack gap={4} aria-label="Verdicts">
      {shown.map((row) => (
        <Group key={row.key} gap="xs" wrap="nowrap">
          <Text size="sm" fw={500}>
            {row.label}
          </Text>
          <Badge
            size="sm"
            variant="light"
            color={row.verdict === WatchpointReadVerdict.Clean ? 'gray' : 'red'}
          >
            {VERDICT_WORDS[row.verdict]}
          </Badge>
        </Group>
      ))}
    </Stack>
  );
}

/**
 * A change that hit a watchpoint set to ask or hold: the daemon's summary, then the folds of the run's reading
 * (read live, so the reviewer's check shows once it ends). An ask card is answered Looks Right or sent back with a
 * note, which files a follow-up task, and the run never waits on it. A card that holds a pull request (`held`)
 * names its link and each watchpoint's verdict, and is answered Merge, which lets the pull request merge, or Send
 * Back, which closes it and files the follow-up.
 */
export function WatchpointCard({
  item,
  header,
  note,
  onNote,
  onAnsweredElsewhere,
  framed = true,
}: WatchpointCardProps) {
  const answer = useCardAnswer(item, {
    onAnswered: () => {
      onNote('');
    },
    onAnsweredElsewhere,
  });
  const workstreamId = item.targets[0]?.workstreamId;
  const reading = useWatchpointHits(workstreamId).data;
  const viewTask = useViewTaskButton(item, !framed);
  // A detail that does not parse is today's card: the daemon wrote it, and a stale one only loses the held parts.
  const parsed = WatchpointCardDetail.safeParse(item.detail);
  const held = parsed.success ? parsed.data.held : undefined;
  const prUrl = held?.prUrl ?? null;

  return (
    <CardSurface framed={framed}>
      <Stack gap={framed ? 'sm' : 'md'} className={framed ? undefined : classes['content']}>
        {header}
        {item.body === '' ? null : (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {item.body}
          </Text>
        )}
        {prUrl === null ? null : <PullRequestLink url={prUrl} />}
        {held === undefined || !parsed.success ? null : <Verdicts rows={parsed.data.watchpoints} />}
        {reading === undefined || reading.hits.length === 0 ? null : (
          <WatchpointFolds hits={reading.hits} open="all" />
        )}
      </Stack>
      <CardActions
        framed={framed}
        start={[
          viewTask,
          reading?.canOpenDiff === true && workstreamId !== undefined ? (
            <WholeDiff workstreamId={workstreamId} />
          ) : null,
        ]}
        error={answer.failure}
        decision={decisionLine(item)}
        sendBack={{
          label: 'What Needs to Change',
          description:
            held === undefined
              ? 'The follow-up task gets this note.'
              : 'Closes the pull request, and the follow-up task gets this note.',
          note,
          onNote,
          onSend: (trimmed) => {
            answer.respond({ choice: WatchpointChoice.SendBack, note: trimmed });
          },
          pending: answer.pending,
        }}
        primary={{
          label: held === undefined ? 'Looks Right' : 'Merge',
          loading: answer.pending,
          onClick: () => {
            answer.respond({
              choice: held === undefined ? WatchpointChoice.LooksRight : WatchpointChoice.Merge,
            });
          },
        }}
      />
    </CardSurface>
  );
}
