import {
  CARD_PROPOSED_PRINCIPLES,
  CARD_RESOLUTION,
  CardResolution,
  ProposedPrinciples,
  SendState,
  type InboxItemDto,
  type PersonDto,
} from '@10db/contracts';
import { Alert, Anchor, Group, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { usePeople } from '../../daemon/people';
import { useSelectedProject } from '../../shell/selected-project';
import { elapsedWords } from '../board/task-state';
import { optionLabel } from './permission-labels';
import { sendFailureWords } from './send-failure';
import { ThreadLink } from './thread-link';

/** The builder's answer as the card offered it; a choice no option matches reads as it was stored. */
export function answerWords(item: InboxItemDto, choice: string): string {
  const option = item.options.find((o) => o.label === choice);
  return option ? optionLabel(item, option) : choice;
}

/** The letter an option has in the message a stakeholder read. */
function letterOf(item: InboxItemDto, choice: string): string {
  const index = item.options.findIndex((o) => o.label === choice);
  return index < 0 ? choice : String.fromCharCode(65 + index);
}

/** An answer a stakeholder gave in Slack: who, how it was read, and their words. */
function slackAnswer(item: InboxItemDto, people: readonly PersonDto[]): string[] | null {
  const answer = item.answer;
  if (answer?.via !== 'slack') return null;
  const who =
    people.find((p) => p.handle === answer.answeredBy)?.name ?? answer.answeredBy ?? 'Someone';
  const send = item.send;
  // How long the answer took, from the question going out to the reply.
  const gap =
    send?.sentAt != null && send.answeredAt != null
      ? ` · ${elapsedWords(send.sentAt, new Date(send.answeredAt).getTime())} after asking`
      : '';
  const lines = [`Answered by ${who} in Slack${gap}`];
  const letter = letterOf(item, answer.choice);
  const readAs = item.send?.readAs;
  if (readAs === 'option') lines.push(`Read as ${letter}`);
  else if (readAs === 'own_words') lines.push('In their own words');
  else if (readAs === 'approved') {
    const others = answer.with ?? [];
    // Handles are stored; the line names the people.
    const names = others.map((handle) => people.find((p) => p.handle === handle)?.name ?? handle);
    lines.push(`Approved ${letter}${names.length > 0 ? ` · with ${names.join(', ')}` : ''}`);
  }
  if (answer.words !== undefined) lines.push(answer.words);
  return lines;
}

/** How the card was closed, in words: 10db's reason, the builder's answer, or just that it is done. */
function resolvedHow(item: InboxItemDto): string {
  // The detail is JSON read back from the daemon: a boundary, so parse it.
  const resolution = CardResolution.safeParse(item.detail?.[CARD_RESOLUTION]);
  if (resolution.success) return `Resolved by 10db: ${resolution.data.reason}`;
  if (item.answer) return `Answered: ${answerWords(item, item.answer.choice)}`;
  return 'Resolved';
}

/** The principles the answer to this card proposed (its note said "always" or "never"); empty for none. */
function proposedBy(item: InboxItemDto): ProposedPrinciples | [] {
  // The detail is JSON read back from the daemon: a boundary, so parse it.
  const proposed = ProposedPrinciples.safeParse(item.detail?.[CARD_PROPOSED_PRINCIPLES]);
  return proposed.success ? proposed.data : [];
}

/**
 * What an open Resolved row shows: how the card closed (a Slack answer's lines, 10db's reason or the
 * builder's answer), the Slack thread, the principles its note proposed, and why a send failed.
 */
export function ResolvedDetail({ item }: { readonly item: InboxItemDto }) {
  const { select } = useSelectedProject();
  const people = usePeople().data ?? [];
  const proposed = proposedBy(item);
  const send = item.send;
  return (
    <Stack gap={4} px="md" py="xs" data-testid="resolved-detail">
      {(slackAnswer(item, people) ?? [resolvedHow(item)]).map((line, index) => (
        <Text key={line} size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
          {index === 0 || line.length > 0 ? line : ''}
        </Text>
      ))}
      {send?.permalink != null && item.answer?.via === 'slack' ? (
        <ThreadLink permalink={send.permalink} />
      ) : null}
      {send?.state === SendState.Failed ? (
        <Alert color="red" variant="light" p="xs">
          {sendFailureWords(
            send.error,
            send.people
              .filter((p) => p.recipient)
              .map((p) => p.name)
              .join(', '),
          )}
        </Alert>
      ) : null}
      {proposed.length === 0 ? null : (
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            {proposed.length === 1
              ? 'A principle was proposed from your note.'
              : `${String(proposed.length)} principles were proposed from your note.`}
          </Text>
          {/* By id: a proposal decided since has left the Proposals tab, and the link still has to
              reach its principle. */}
          {proposed.map(({ principleId }, index) => (
            <Anchor
              key={principleId}
              size="xs"
              // `Anchor component={Link}` loses the route's typed search, so the link is rendered here.
              renderRoot={(props) => (
                <Link
                  {...props}
                  to="/knowledge"
                  search={{ principle: principleId }}
                  onClick={() => {
                    // Knowledge shows the selected project's records, so land on the card's own.
                    select(item.projectId);
                  }}
                />
              )}
            >
              {proposed.length === 1 ? 'Open in Knowledge' : `Open principle ${String(index + 1)}`}
            </Anchor>
          ))}
        </Group>
      )}
    </Stack>
  );
}
