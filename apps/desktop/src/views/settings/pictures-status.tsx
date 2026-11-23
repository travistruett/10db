import { BrowserState, type ProjectId } from '@10db/contracts';
import { Group, Text } from '@mantine/core';
import { usePicturesStatus } from '../../daemon/screen-queries';
import { ConnectionStatus, ConnectionTone } from './connection-status';
import { HelpHint } from './help-hint';

// Workbench spec §10: how the browser that takes a project's pictures stands, and its last sign-in.

const BROWSER_STATUS = {
  [BrowserState.Off]: { tone: ConnectionTone.Off, label: 'Picture Browser Not Started' },
  [BrowserState.Fetching]: { tone: ConnectionTone.NeedsYou, label: 'Picture Browser Downloading' },
  [BrowserState.Ready]: { tone: ConnectionTone.Works, label: 'Picture Browser Ready' },
  [BrowserState.Refused]: { tone: ConnectionTone.NeedsYou, label: 'Picture Browser Unavailable' },
} as const satisfies Record<BrowserState, { tone: ConnectionTone; label: string }>;

/** The picture browser's state as a dot and words for the card's action slot; problems sit behind an info button. */
export function PicturesStatus({ projectId }: { readonly projectId: ProjectId }) {
  const status = usePicturesStatus(projectId);
  if (status.data === undefined) return null;
  const { browser, signIn } = status.data;
  const { tone, label } = BROWSER_STATUS[browser.state];
  const signInLine =
    signIn === null
      ? null
      : signIn.problem === null
        ? 'Last sign-in: signed in'
        : `Last sign-in: ${signIn.problem}`;
  const details = [browser.problem, signInLine].filter((line) => line !== null);
  return (
    <Group gap={2} wrap="nowrap">
      <ConnectionStatus tone={tone} label={label} />
      {details.length === 0 ? null : (
        <HelpHint label="the picture browser">
          {details.map((line) => (
            <Text key={line} size="sm">
              {line}
            </Text>
          ))}
        </HelpHint>
      )}
    </Group>
  );
}
