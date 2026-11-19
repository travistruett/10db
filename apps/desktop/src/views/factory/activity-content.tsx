import type { ActivityRow } from '@10db/contracts';
import { Anchor, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { ProjectLabel } from '../../shell/project-label';
import { useSelectedProject } from '../../shell/selected-project';

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const when = (iso: string): string => WHEN.format(new Date(iso));

/**
 * The content for an Activity row: the notice's line and body, how often and when when it was grouped, its
 * project and a link to its task. A notice asks nothing, so there is no answer and no Dismiss.
 */
export function ActivityContent({ row }: { readonly row: ActivityRow }) {
  const { select } = useSelectedProject();
  const { projectId, taskId } = row;
  return (
    <Stack gap="sm" data-testid="activity-content">
      <Text fw={600}>{row.line}</Text>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        {row.body}
      </Text>
      {row.count > 1 ? (
        <Text size="xs" c="dimmed">
          {`${String(row.count)} times, from ${when(row.firstAt)} to ${when(row.at)}`}
        </Text>
      ) : (
        <Text size="xs" c="dimmed">
          {when(row.at)}
        </Text>
      )}
      {projectId === null ? null : <ProjectLabel projectId={projectId} />}
      {taskId === null ? null : (
        <Anchor
          renderRoot={(props) => <Link {...props} to="/board" search={{ task: taskId }} />}
          size="sm"
          onClick={() => {
            if (projectId !== null) select(projectId);
          }}
        >
          Open Task
        </Anchor>
      )}
    </Stack>
  );
}
