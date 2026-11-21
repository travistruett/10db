import {
  ScreenTheme,
  type DesignCheckDto,
  type DesignCheckShot,
  type TaskId,
} from '@10db/contracts';
import { Group, Stack, Text } from '@mantine/core';
import { ZoomablePicture } from '../../conversation';
import { useDesignCheckPicture, useTaskDesignCheck } from '../../daemon/screen-queries';
import { useNow } from '../../shell/relative';
import { shortAgo } from '../factory/short-ago';

// Plan-in-sessions spec §4, "Design review": a task's newest design check in its drawer, the approved
// mock-up beside the app as it was shot, per route, with what the agent said still differs.

const labelOf = (shot: DesignCheckShot): string =>
  [
    shot.route,
    `${String(shot.viewport.width)} by ${String(shot.viewport.height)}`,
    ...(shot.theme === ScreenTheme.Default ? [] : [`${shot.theme} theme`]),
  ].join(', ');

function CheckPicture({
  check,
  part,
  alt,
}: {
  readonly check: DesignCheckDto;
  readonly part: 'mockup' | number;
  readonly alt: string;
}) {
  const image = useDesignCheckPicture(check.id, part);
  if (image.isError)
    return (
      <Text size="xs" c="dimmed" w={220}>
        {alt} can no longer be shown.
      </Text>
    );
  if (image.data === undefined)
    return (
      <Text size="xs" c="dimmed" w={220}>
        Loading {alt}…
      </Text>
    );
  return (
    <ZoomablePicture
      src={image.data}
      alt={alt}
      style={{
        display: 'block',
        width: 220,
        maxWidth: '100%',
        height: 'auto',
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-sm)',
      }}
    />
  );
}

export function DesignCheckView({ taskId }: { readonly taskId: TaskId }) {
  const checks = useTaskDesignCheck(taskId).data?.checks ?? [];
  const now = useNow();
  const first = checks[0];
  if (first === undefined) return null;
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">{`Design check · ${shortAgo(first.createdAt, now)}`}</Text>
      {checks.map((check) => (
        <Stack key={check.id} gap={4}>
          {check.shots.length === 0 ? (
            <Text size="xs" c="dimmed">
              No pictures of the page were taken.
            </Text>
          ) : null}
          {check.shots.map((shot, index) => (
            <Stack
              key={`${shot.route}:${String(index)}`}
              gap={4}
              role="group"
              aria-label={labelOf(shot)}
            >
              <Text size="xs" c="dimmed">
                {labelOf(shot)}
              </Text>
              <Group gap="xs" align="flex-start" wrap="nowrap">
                {check.mockupSha256 === null ? (
                  <Text size="xs" c="dimmed" w={220}>
                    The mock-up could not be drawn
                  </Text>
                ) : (
                  <CheckPicture
                    check={check}
                    part="mockup"
                    alt={`Mock-up, drawn for ${shot.route}`}
                  />
                )}
                {shot.sha256 === null ? (
                  <Text size="xs" c="dimmed" w={220}>
                    {shot.missing ?? 'No picture of the page'}
                  </Text>
                ) : (
                  <CheckPicture
                    check={check}
                    part={index}
                    alt={`${shot.route} as the app showed it`}
                  />
                )}
              </Group>
            </Stack>
          ))}
          {check.verdict === null ? null : <Text size="sm">{check.verdict}</Text>}
        </Stack>
      ))}
    </Stack>
  );
}
