import { PassState } from '@10db/contracts';
import { Group, Loader, Text } from '@mantine/core';

/** What a pass that is ending is doing, in words; null while it is open or once it has ended. */
export function closeProgressLine(state: PassState): string | null {
  switch (state) {
    case PassState.Closing:
      return 'Closing the pass…';
    case PassState.Abandoning:
      return 'Abandoning the pass…';
    case PassState.Open:
    case PassState.Closed:
    case PassState.Settled:
    case PassState.Abandoned:
      return null;
  }
}

/** The pass's close or abandon under way (Workbench spec §5.4), said once under the header line. */
export function CloseProgress({ state }: { readonly state: PassState }) {
  const line = closeProgressLine(state);
  if (line === null) return null;
  return (
    <Group gap="xs" role="status" wrap="nowrap">
      <Loader size="xs" />
      <Text size="sm">{line}</Text>
    </Group>
  );
}
