import {
  CARD_PROPOSED_PRINCIPLES,
  CARD_RESOLUTION,
  CardResolution,
  ProposedPrinciples,
  type InboxItemDto,
  type ProjectId,
} from '@10db/contracts';
import { Alert, Anchor, Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useResolvedInbox } from '../../daemon/queries';
import { ProjectLabel } from '../../shell/project-label';
import { useSelectedProject } from '../../shell/selected-project';
import { inProject } from './in-project';
import { KIND_LABELS, optionLabel } from './permission-labels';

/** The builder's answer as the card offered it; a choice no option matches reads as it was stored. */
function answerWords(item: InboxItemDto, choice: string): string {
  const option = item.options.find((o) => o.label === choice);
  return option ? optionLabel(item, option) : choice;
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
                <Text size="xs" c="dimmed">
                  {resolvedHow(item)}
                </Text>
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
