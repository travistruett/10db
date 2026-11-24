import { LinearEventKind, LinearPostState, type LinearPostDto, type TaskId } from '@10db/contracts';
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
        <ExternalLink
          key={id}
          url={`${issueUrl}#comment-${id.slice(0, 8)}`}
          label="Comment"
          size="xs"
        />
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

/**
 * What the reporter owes a task's Linear issue and has posted to it, newest first. A follow-up shows its source's
 * issue and only the updates made for the follow-up itself.
 */
export function LinearTab({ taskId }: { readonly taskId: TaskId }) {
  const now = useNow();
  const query = useTaskLinearPosts(taskId);
  if (query.isPending) return null;
  if (query.isError)
    return (
      <Text size="sm" c="red">
        Couldn't read the Linear updates: {query.error.message}
      </Text>
    );
  const { link, followUpOf, posts } = query.data;
  if (link === null) return null;
  return (
    <Stack gap="sm">
      <Group gap={8}>
        <ExternalLink url={link.url} label={link.id} size="sm" />
        {followUpOf === null ? null : (
          <Text size="xs" c="dimmed">
            Follow-up of {followUpOf.title}; it reports to this issue.
          </Text>
        )}
      </Group>
      {posts.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing has been reported to {link.id} yet.
        </Text>
      ) : (
        <Stack gap="sm" role="list" aria-label="Linear updates">
          {posts.map((post) => (
            <PostRow key={post.id} post={post} issueUrl={link.url} now={now} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
