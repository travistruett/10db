import {
  AcceptanceChoice,
  AcceptanceDetail,
  AcceptanceVerdict,
  type InboxItemDto,
} from '@10db/contracts';
import { Accordion, List, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { CardActions } from './card-actions';
import { CardSurface } from './card-surface';
import { acceptanceCounts, decisionLine } from './decision-line';
import classes from './inbox-card.module.css';
import { useCardAnswer } from './use-card-answer';
import { useViewTaskButton } from './view-task';

export interface AcceptanceCardProps {
  readonly item: InboxItemDto;
  /** The kind badge and title, laid out as on every other expanded card. */
  readonly header: ReactNode;
  /** The Send back note, kept by the Inbox so deselecting the card does not lose it. */
  readonly note: string;
  readonly onNote: (note: string) => void;
  /** Called when the card turned out to be answered elsewhere; without it the card says so itself. */
  readonly onAnsweredElsewhere?: () => void;
  readonly framed?: boolean;
}

/** From here the evidence starts open: the Mac's pane has the room, a phone keeps it folded under the counts. */
const WIDE_QUERY = '(min-width: 48em)';

/** The fold's header: how many criteria are unconfirmed and whether an extra behaviour is named. */
const evidenceHeader = (unmet: number, extra: boolean): string =>
  [unmet === 0 ? null : `${String(unmet)} unconfirmed`, extra ? '1 extra' : null]
    .filter((part) => part !== null)
    .join(', ');

/**
 * Criteria 10db could not prove on work that went on, after sending it back for proof as often as its budget
 * allows, or that only the builder can prove: the builder accepts them without proof, drops them from the task,
 * or sends them back with a note, which files a follow-up task. The run never waits on this card.
 */
export function AcceptanceCard({
  item,
  header,
  note,
  onNote,
  onAnsweredElsewhere,
  framed = true,
}: AcceptanceCardProps) {
  const answer = useCardAnswer(item, {
    onAnswered: () => {
      onNote('');
    },
    onAnsweredElsewhere,
  });
  const viewTask = useViewTaskButton(item, !framed);
  const detail = AcceptanceDetail.safeParse(item.detail);
  const open = detail.success
    ? detail.data.criteria.filter((c) => c.verdict !== AcceptanceVerdict.Met)
    : [];

  const { unmet, extra } = acceptanceCounts(item);
  // Read before the first paint, so the fold mounts open or shut and never springs open.
  const wide = useMediaQuery(WIDE_QUERY, true, { getInitialValueInEffect: false });

  return (
    <CardSurface framed={framed}>
      <Stack gap={framed ? 'sm' : 'md'} className={framed ? undefined : classes['content']}>
        {header}
        {open.length === 0 && !extra ? null : (
          // The header says the counts and the line by the buttons says what each answer does; a phone folds the
          // evidence away under them.
          <Accordion
            variant="contained"
            chevronPosition="left"
            defaultValue={wide ? 'evidence' : null}
          >
            <Accordion.Item value="evidence">
              <Accordion.Control>{evidenceHeader(unmet, extra)}</Accordion.Control>
              <Accordion.Panel>
                <Stack gap="sm">
                  {open.length === 0 ? null : (
                    <List size="sm" spacing={4}>
                      {open.map((c) => (
                        <List.Item key={c.criterion}>
                          {c.criterion}
                          <Text size="xs" c="dimmed">
                            {c.note}
                          </Text>
                        </List.Item>
                      ))}
                    </List>
                  )}
                  {detail.success && detail.data.unasked !== null ? (
                    <Text size="sm">
                      It may also do something the task didn't ask for: {detail.data.unasked}
                    </Text>
                  ) : null}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        )}
      </Stack>
      <CardActions
        framed={framed}
        start={[viewTask]}
        error={answer.failure}
        decision={decisionLine(item)}
        sendBack={{
          label: 'What Needs to Change',
          description: 'The follow-up task gets this note.',
          note,
          onNote,
          onSend: (trimmed) => {
            answer.respond({ choice: AcceptanceChoice.SendBack, note: trimmed });
          },
          pending: answer.pending,
        }}
        secondary={
          item.options.some((o) => o.label === AcceptanceChoice.Drop)
            ? [
                {
                  label: 'Drop It',
                  disabled: answer.pending,
                  onClick: () => {
                    answer.respond({ choice: AcceptanceChoice.Drop });
                  },
                },
              ]
            : []
        }
        primary={{
          label: 'Accept Without Proof',
          loading: answer.pending,
          onClick: () => {
            answer.respond({ choice: AcceptanceChoice.Accept });
          },
        }}
      />
    </CardSurface>
  );
}
