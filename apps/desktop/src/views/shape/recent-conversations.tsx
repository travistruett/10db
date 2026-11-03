import type { ProjectId, ShapeDto, ShapeViewDto } from '@10db/contracts';
import { Alert, Box, Group, Loader, Stack, Text } from '@mantine/core';
import { useShapes, useShapeView } from '../../daemon/shape-queries';
import { useNow } from '../../shell/relative';
import { shortAgo } from '../factory/short-ago';
import { ConversationLink } from './conversation-link';

/** How many past conversations sit under the composer; each asks for its own view to count what it made. */
const LISTED = 8;

/** What the conversation's converted rows became, in the builder's words. */
export function producedLine(view: ShapeViewDto | undefined): string | null {
  if (view === undefined) return null;
  let goals = 0;
  let tasks = 0;
  for (const row of view.proposals) {
    if (row.converted === null) continue;
    if (row.converted.goalId !== null) goals += 1;
    tasks += row.converted.taskIds.length;
  }
  if (goals === 0 && tasks === 0) return 'Nothing converted yet';
  const parts: string[] = [];
  if (goals > 0) parts.push(`${String(goals)} ${goals === 1 ? 'goal' : 'goals'}`);
  if (tasks > 0) parts.push(`${String(tasks)} ${tasks === 1 ? 'task' : 'tasks'}`);
  return parts.join(' · ');
}

/**
 * The project's recent conversations under the new-conversation composer: title, last activity and
 * what each produced; one click reopens it. Nothing shows while there are none.
 */
export function RecentConversations({ projectId }: { readonly projectId: ProjectId | null }) {
  const shapes = useShapes(projectId);
  const now = useNow();

  if (shapes.isLoading) return <Loader size="xs" aria-label="Loading conversations" m="md" />;
  if (shapes.isError) {
    return (
      <Alert color="red" p="xs" m="md">
        <Text size="xs">Couldn&apos;t load conversations</Text>
      </Alert>
    );
  }
  const recent = (shapes.data ?? []).slice(0, LISTED);
  if (recent.length === 0) return null;
  return (
    <Box px="md" pb="md" style={{ flex: 'none', maxHeight: '45%', overflowY: 'auto' }}>
      <Text size="xs" fw={600} c="dimmed" mb={4}>
        Recent
      </Text>
      <Stack
        component="ul"
        gap={2}
        aria-label="Recent conversations"
        m={0}
        p={0}
        style={{ listStyle: 'none' }}
      >
        {recent.map((shape) => (
          <RecentRow key={shape.id} shape={shape} now={now} />
        ))}
      </Stack>
    </Box>
  );
}

function RecentRow({ shape, now }: { readonly shape: ShapeDto; readonly now: number }) {
  const view = useShapeView(shape.id);
  return (
    <li style={{ listStyle: 'none' }}>
      <ConversationLink shapeId={shape.id}>
        <Text size="sm" fw={500} lineClamp={1}>
          {shape.title}
        </Text>
        <Group gap={6} wrap="nowrap">
          <Text size="xs" c="dimmed">
            {shortAgo(shape.updatedAt, now)}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {producedLine(view.data)}
          </Text>
        </Group>
      </ConversationLink>
    </li>
  );
}
