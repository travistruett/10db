import { Anchor, Group, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useSelfUpdate } from '../../daemon/self-update-queries';
import { absoluteTime } from '../../shell/relative';
import { SettingsSectionKey } from '../settings/sections';

/**
 * Says why lanes paused: an update waited past its limit, so 10db starts no new steps until what
 * runs has finished and the app has installed and restarted. Nothing shows while it only waits.
 */
export function UpdateDrainNote() {
  const status = useSelfUpdate().data;
  if (
    status === undefined ||
    !status.enabled ||
    !status.draining ||
    status.drainingSince === null ||
    status.availableCommit === null
  )
    return null;
  return (
    <Group gap={6} wrap="nowrap" role="status" aria-label="Update draining the factory">
      <IconDownload size={16} stroke={1.5} color="var(--mantine-color-yellow-6)" aria-hidden />
      <Text size="xs" c="dimmed">
        {`Lanes are paused since ${absoluteTime(status.drainingSince)} for an update to ${status.availableCommit.slice(0, 7)}: running steps finish, then 10db installs and restarts, and lanes resume.`}{' '}
        <Anchor
          size="xs"
          renderRoot={(props) => (
            <Link
              {...props}
              to="/settings/$section"
              params={{ section: SettingsSectionKey.Updates }}
            />
          )}
        >
          Update settings
        </Anchor>
      </Text>
    </Group>
  );
}
