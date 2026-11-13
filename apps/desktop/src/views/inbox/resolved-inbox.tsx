import {
  CARD_PROPOSED_PRINCIPLES,
  CARD_RESOLUTION,
  CardResolution,
  ProposedPrinciples,
  type InboxItemDto,
  type PersonDto,
  type ProjectId,
} from '@10db/contracts';
import { Alert, Anchor, Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { usePeople } from '../../daemon/people';
import { useResolvedInbox } from '../../daemon/queries';
import { ProjectLabel } from '../../shell/project-label';
import { useSelectedProject } from '../../shell/selected-project';
import { inProject } from './in-project';
import { elapsedWords } from '../board/task-state';
import { ThreadLink } from './thread-link';
import { KIND_LABELS, optionLabel } from './permission-labels';

/** The builder's answer as the card offered it; a choice no option matches reads as it was stored. */
function answerWords(item: InboxItemDto, choice: string): string {
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

/** The inbox's resolved view: cards that were answered, dismissed, or closed by 10db, newest first. */
export function ResolvedInbox({ project }: { readonly project: ProjectId | undefined }) {
  const resolved = useResolvedInbox();
  const { select } = useSelectedProject();
  const people = usePeople().data ?? [];
  // The daemon sends the most recent ones (RESOLVED_SHOWN); sorted here too, so the order never
  // depends on the response's.
  const items = inProject(resolved.data ?? [], project).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  return (
    <Stack gap="xs">
      {resolved.isError ? (
        <Alert color="red" title="Couldn't load the resolved cards">
          {resolved.error.message}
        </Alert>
      ) : null}
      {resolved.isSuccess && items.length === 0 ? (
        <Text c="dimmed">Nothing has been resolved yet.</Text>
      ) : null}
      {items.map((item) => {
        const proposed = proposedBy(item);
        return (
          <Paper key={item.id} withBorder p="sm" data-testid="resolved-card">
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <Badge size="sm" variant="light" color="gray" style={{ flexShrink: 0 }}>
                {KIND_LABELS[item.kind]}
              </Badge>
              <ProjectLabel projectId={item.projectId} />
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Text size="sm" lineClamp={2} title={item.title}>
                  {item.title}
                </Text>
                {(slackAnswer(item, people) ?? [resolvedHow(item)]).map((line, index) => (
                  <Text key={line} size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                    {index === 0 || line.length > 0 ? line : ''}
                  </Text>
                ))}
                {item.send?.permalink != null && item.answer?.via === 'slack' ? (
                  <ThreadLink permalink={item.send.permalink} />
                ) : null}
                {proposed.length === 0 ? null : (
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      {proposed.length === 1
                        ? 'A principle was proposed from your note.'
                        : `${String(proposed.length)} principles were proposed from your note.`}
                    </Text>
                    {/* By id: a proposal decided since has left the Proposals tab, and the link still
                        has to reach its principle. */}
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
                        {proposed.length === 1
                          ? 'Open in Knowledge'
                          : `Open principle ${String(index + 1)}`}
                      </Anchor>
                    ))}
                  </Group>
                )}
              </Stack>
            </Group>
          </Paper>
        );
      })}
    </Stack>
  );
}
