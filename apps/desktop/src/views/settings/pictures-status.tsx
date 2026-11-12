import { BrowserState, type ProjectId } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import { usePicturesStatus } from '../../daemon/screen-queries';

// Workbench spec §10: how the browser that takes a project's pictures stands, and its last sign-in.

const BROWSER_WORDS = {
  [BrowserState.Off]: 'not started yet',
  [BrowserState.Fetching]: 'downloading',
  [BrowserState.Ready]: 'ready',
  [BrowserState.Refused]: 'unavailable',
} as const satisfies Record<BrowserState, string>;

export function PicturesStatus({ projectId }: { readonly projectId: ProjectId }) {
  const status = usePicturesStatus(projectId);
  if (status.data === undefined) return null;
  const { browser, signIn } = status.data;
  return (
    <Stack gap={2}>
      <Text size="sm" c={browser.state === BrowserState.Refused ? 'red' : 'dimmed'}>
        {`Browser for pictures: ${BROWSER_WORDS[browser.state]}`}
      </Text>
      {browser.problem === null ? null : (
        <Text size="xs" c="dimmed">
          {browser.problem}
        </Text>
      )}
      {signIn === null ? null : (
        <Text size="xs" c={signIn.problem === null ? 'dimmed' : 'red'}>
          {signIn.problem === null ? 'Last sign-in: signed in' : `Last sign-in: ${signIn.problem}`}
        </Text>
      )}
    </Stack>
  );
}
