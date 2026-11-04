import {
  CARD_PROPOSED_PRINCIPLES,
  CARD_RESOLUTION,
  CardResolution,
  ProposedPrinciples,
  type InboxItemDto,
} from '@10db/contracts';
import { Alert, Anchor, Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useResolvedInbox } from '../../daemon/queries';
import { useSelectedProject } from '../../shell/selected-project';
import { KIND_LABELS } from './permission-labels';

/** How the card was closed, in words: 10db's reason, the builder's answer, or just that it is done. */
function resolvedHow(item: InboxItemDto): string {
  // The detail is JSON read back from the daemon: a boundary, so parse it.
  const resolution = CardResolution.safeParse(item.detail?.[CARD_RESOLUTION]);
  if (resolution.success) return `Resolved by 10db: ${resolution.data.reason}`;
  if (item.answer) return `Answered: ${item.answer.choice}`;
  return 'Resolved';
}

/** How many principles the answer to this card proposed (its note said "always" or "never"); 0 for none. */
function proposedCount(item: InboxItemDto): number {
  // The detail is JSON read back from the daemon: a boundary, so parse it.
  const proposed = ProposedPrinciples.safeParse(item.detail?.[CARD_PROPOSED_PRINCIPLES]);
  return proposed.success ? proposed.data.length : 0;
}

/** The inbox's resolved view: cards that were answered, dismissed, or closed by 10db, newest first. */
export function ResolvedInbox() {
  const resolved = useResolvedInbox();
  const { select } = useSelectedProject();
  // The daemon sends the most recent ones (RESOLVED_SHOWN); sorted here too, so the order never
  // depends on the response's.
  const items = [...(resolved.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
        const proposed = proposedCount(item);
        return (
          <Paper key={item.id} withBorder p="sm" data-testid="resolved-card">
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <Badge size="sm" variant="light" color="gray" style={{ flexShrink: 0 }}>
                {KIND_LABELS[item.kind]}
              </Badge>
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Text size="sm" lineClamp={2} title={item.title}>
                  {item.title}
                </Text>
                <Text size="xs" c="dimmed">
                  {resolvedHow(item)}
                </Text>
                {proposed === 0 ? null : (
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      {proposed === 1
                        ? 'A principle was proposed from your note.'
                        : `${String(proposed)} principles were proposed from your note.`}
                    </Text>
                    {/* The proposals wait for a verdict in the Knowledge view's Proposals tab. */}
                    <Anchor
                      size="xs"
                      // `Anchor component={Link}` loses the route's typed search, so the link is rendered here.
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/knowledge"
                          search={{ tab: 'proposals' }}
                          onClick={() => {
                            // Knowledge shows the selected project's proposals, so land on the card's own.
                            select(item.projectId);
                          }}
                        />
                      )}
                    >
                      Open in Knowledge
                    </Anchor>
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
