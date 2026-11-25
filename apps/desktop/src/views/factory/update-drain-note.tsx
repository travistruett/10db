import type { SelfUpdateStatusDto } from '@10db/contracts';
import { Anchor, Badge, HoverCard, Stack, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useSelfUpdate } from '../../daemon/self-update-queries';
import { clockTime } from '../../shell/relative';
import { SettingsSectionKey } from '../settings/sections';
import { updateDeadline, updateWaitsFor } from '../settings/update-waits-for';

const SHORT = 7;

/** What the pill says, the name it is announced by, the longer text behind it, and its colour. */
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
      label: 'Lanes Paused for Update',
      text: `Lanes paused at ${clockTime(status.drainingSince)} to install the update to ${build}. What is running finishes first, then 10db restarts with the update and lanes resume. ${waitsFor}`,
      color: 'yellow',
    };
  const deadline = updateDeadline(status);
  if (deadline !== null)
    return {
      label: 'Update Waiting',
      text: `An update to ${build} is ready. 10db installs it as soon as nothing is running. If it is still waiting at ${deadline}, lanes pause so it can install. ${waitsFor}`.trimEnd(),
      color: 'gray',
    };
  return null;
}

/**
 * A pill in Factory's title row saying an update waits for an idle moment, or has paused lanes until it
 * installs; hovering it says why, what it waits for, and links to Update Settings.
 */
export function UpdateDrainNote() {
  const status = useSelfUpdate().data;
  const note = status === undefined ? null : noteFor(status);
  if (note === null) return null;
  return (
    <HoverCard width={340} position="bottom-end" withArrow openDelay={150}>
      <HoverCard.Target>
        <Badge
          component="button"
          type="button"
          role="status"
          aria-label={note.label}
          variant="light"
          color={note.color}
          size="lg"
          tt="none"
          fw={500}
          leftSection={<IconDownload size={14} stroke={1.5} aria-hidden />}
          style={{ cursor: 'default' }}
        >
          {note.label}
        </Badge>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap={6}>
          <Text size="xs">{note.text}</Text>
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
            Update Settings
          </Anchor>
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
