import {
  LinearEventKind,
  LinearPostState,
  type LinearPostDto,
  type TaskDto,
} from '@10db/contracts';
import { Badge, Group, Stack, Text } from '@mantine/core';
import { useTaskLinearPosts } from '../../daemon/linear-queries';
import { absoluteTime, fromNow, useNow } from '../../shell/relative';
import { ExternalLink } from './pull-request-link';

const EVENT_LABELS: Readonly<Record<LinearEventKind, string>> = {
  [LinearEventKind.RunStarted]: 'Run Started',
  [LinearEventKind.Waiting]: 'Waiting on You',
  [LinearEventKind.Verdict]: 'Verdict',
  [LinearEventKind.Ended]: 'Run Ended',
  [LinearEventKind.PrOpened]: 'Pull Request Opened',
  [LinearEventKind.PrMerged]: 'Pull Request Merged',
};

const STATE_LABELS: Readonly<Record<LinearPostState, string>> = {
  [LinearPostState.Pending]: 'Waiting',
  [LinearPostState.Recorded]: 'Recorded',
  [LinearPostState.Withheld]: 'Withheld',
  [LinearPostState.Failed]: 'Failed',
};

const STATE_COLORS: Readonly<Record<LinearPostState, string>> = {
  [LinearPostState.Pending]: 'gray',
  [LinearPostState.Recorded]: 'green',
  [LinearPostState.Withheld]: 'orange',
  [LinearPostState.Failed]: 'red',
};

function PostRow({
  post,
  issueUrl,
  now,
}: {
  readonly post: LinearPostDto;
  readonly issueUrl: string;
  readonly now: number;
}) {
  const at = post.recordedAt ?? post.createdAt;
  return (
    <Stack gap={2} role="listitem" aria-label={EVENT_LABELS[post.event]}>
      <Group gap={8} wrap="nowrap">
        <Text size="sm" fw={500}>
          {EVENT_LABELS[post.event]}
        </Text>
        <Text size="xs" c="dimmed">
          Attempt {post.attempt}
        </Text>
        <Badge size="xs" variant="light" color={STATE_COLORS[post.state]}>
          {STATE_LABELS[post.state]}
        </Badge>
        <Text size="xs" c="dimmed" component="time" dateTime={at} title={absoluteTime(at)}>
          {/* Every time here is past: one stamped after the clock's last tick reads as just now. */}
          {fromNow(at, Math.max(now, Date.parse(at)))}
        </Text>
      </Group>
      {post.commentIds.map((id) => (
        <ExternalLink key={id} url={`${issueUrl}#comment-${id}`} label="Comment" size="xs" />
      ))}
      {post.statusSet === null ? null : (
        <Text size="xs" c="dimmed">
          Status set to {post.statusSet}
        </Text>
      )}
      {post.withheldPattern === null ? null : (
        <Text size="xs" c="dimmed">
          Withheld: {post.withheldPattern}
        </Text>
      )}
      {post.lastError === null || post.state === LinearPostState.Recorded ? null : (
        <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
          {post.lastError}
        </Text>
      )}
    </Stack>
  );
}

/** What the reporter owes a task's Linear issue and has posted to it, newest first. */
export function LinearTab({ task }: { readonly task: Pick<TaskDto, 'id' | 'external'> }) {
  const now = useNow();
  const posts = useTaskLinearPosts(task.id).data ?? [];
  if (task.external == null) return null;
  if (posts.length === 0)
    return (
      <Text size="sm" c="dimmed">
        Nothing has been reported to {task.external.id} yet.
      </Text>
    );
  return (
    <Stack gap="sm" role="list" aria-label="Linear updates">
      {posts.map((post) => (
        <PostRow key={post.id} post={post} issueUrl={task.external?.url ?? ''} now={now} />
      ))}
    </Stack>
  );
}
