import type { SelfUpdateStatusDto } from '@10db/contracts';
import { Anchor, Group, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useSelfUpdate } from '../../daemon/self-update-queries';
import { absoluteTime } from '../../shell/relative';
import { SettingsSectionKey } from '../settings/sections';
import { updateWaitsFor } from '../settings/update-waits-for';

const SHORT = 7;

/** What the note says, the name it is announced by, and its icon's colour. */
interface Note {
  readonly label: string;
  readonly text: string;
  readonly color: string;
}

function noteFor(status: SelfUpdateStatusDto): Note | null {
  // An update that will not install neither waits nor drains, whatever else the status still holds.
  if (!status.enabled || status.availableCommit === null || status.notInstalling !== null)
    return null;
  const build = status.availableCommit.slice(0, SHORT);
  const waitsFor = updateWaitsFor(status);
  if (status.draining && status.drainingSince !== null)
    return {
      label: 'Update draining the factory',
      text: `Lanes are paused since ${absoluteTime(status.drainingSince)} for an update to ${build}: running steps finish, then 10db installs and restarts, and lanes resume. ${waitsFor}`,
      color: 'var(--mantine-color-yellow-6)',
    };
  if (status.waitingSince !== null)
    return {
      label: 'Update waiting',
      text: `An update to ${build} is waiting since ${absoluteTime(status.waitingSince)} for a moment when nothing is mid-session. If none comes within ${String(status.waitMinutes)} minutes, lanes pause until it has installed. ${waitsFor}`.trimEnd(),
      color: 'var(--mantine-color-dimmed)',
    };
  return null;
}

/**
 * Says why lanes paused, or are about to: an update waits for an idle moment, and past its limit 10db
 * starts no new steps until what runs has finished and the app has installed and restarted.
 */
export function UpdateDrainNote() {
  const status = useSelfUpdate().data;
  const note = status === undefined ? null : noteFor(status);
  if (note === null) return null;
  return (
    <Group gap={6} wrap="nowrap" role="status" aria-label={note.label}>
      <IconDownload size={16} stroke={1.5} color={note.color} aria-hidden />
      <Text size="xs" c="dimmed">
        {note.text}{' '}
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
