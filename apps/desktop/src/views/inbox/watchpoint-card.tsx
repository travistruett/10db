import { WatchpointChoice, type InboxItemDto } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { useWatchpointHits } from '../../daemon/watchpoint-queries';
import { WatchpointFolds, WholeDiff } from '../board/watchpoint-folds';
import { CardActions } from './card-actions';
import { CardSurface } from './card-surface';
import classes from './inbox-card.module.css';
import { useCardAnswer } from './use-card-answer';
import { useTaskOfRun, ViewTaskButton } from './view-task';

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

/**
 * A change that hit a watchpoint set to ask: the daemon's summary, then the folds of the run's reading (read
 * live, so the reviewer's check shows once it ends), answered Looks Right or sent back with a note, which files
 * a follow-up task. The run never waits on this card.
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
  const taskId = useTaskOfRun(item);

  return (
    <CardSurface framed={framed}>
      <Stack gap={framed ? 'sm' : 'md'} className={framed ? undefined : classes['content']}>
        {header}
        {item.body === '' ? null : (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {item.body}
          </Text>
        )}
        {reading === undefined || reading.hits.length === 0 ? null : (
          <WatchpointFolds hits={reading.hits} open="all" />
        )}
      </Stack>
      <CardActions
        framed={framed}
        start={[
          framed || taskId === null ? null : <ViewTaskButton taskId={taskId} />,
          reading?.canOpenDiff === true && workstreamId !== undefined ? (
            <WholeDiff workstreamId={workstreamId} />
          ) : null,
        ]}
        error={answer.failure}
        sendBack={{
          label: 'What Needs to Change',
          description: 'The follow-up task gets this note.',
          note,
          onNote,
          onSend: (trimmed) => {
            answer.respond({ choice: WatchpointChoice.SendBack, note: trimmed });
          },
          pending: answer.pending,
        }}
        primary={{
          label: 'Looks Right',
          loading: answer.pending,
          onClick: () => {
            answer.respond({ choice: WatchpointChoice.LooksRight });
          },
        }}
      />
    </CardSurface>
  );
}
