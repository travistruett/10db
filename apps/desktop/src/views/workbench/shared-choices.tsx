import { SharedChoiceKind, type SharedChoice, type SharedUnlandedDto } from '@10db/contracts';
import { Box, Group, SegmentedControl, Stack, Text } from '@mantine/core';

// Workbench spec §7.2: a page leaving the pass with shared changes that have not landed keeps each
// (the default) or drops it, back to what its grant found. Drop is offered only when nothing later
// stands on the change; otherwise the daemon's reason is said instead.

/** Each change as the builder chose, Keep for any not chosen. */
export function sharedChoicesOf(
  changes: readonly SharedUnlandedDto[],
  chosen: ReadonlyMap<number, SharedChoiceKind>,
): SharedChoice[] {
  return changes.map((change) => ({
    seq: change.seq,
    choice:
      change.dropRefusal === null
        ? (chosen.get(change.seq) ?? SharedChoiceKind.Keep)
        : SharedChoiceKind.Keep,
  }));
}

/** "People changed these files later.", "People and Billing changed…". */
function laterLine(pages: readonly string[]): string {
  const names =
    pages.length < 2
      ? pages.join('')
      : `${pages.slice(0, -1).join(', ')} and ${pages.at(-1) ?? ''}`;
  return `${names} changed these files later.`;
}

export interface SharedChoicesProps {
  readonly changes: readonly SharedUnlandedDto[];
  readonly chosen: ReadonlyMap<number, SharedChoiceKind>;
  readonly onChoose: (seq: number, choice: SharedChoiceKind) => void;
  readonly disabled?: boolean;
}

/**
 * Keep or Drop for each shared change: its files, the pages that changed them later named first, and
 * Drop disabled with the daemon's reason when it is refused.
 */
export function SharedChoices({ changes, chosen, onChoose, disabled = false }: SharedChoicesProps) {
  return (
    <Stack gap="sm">
      {changes.map((change) => {
        const paths = change.paths.join(', ');
        const choice =
          change.dropRefusal === null
            ? (chosen.get(change.seq) ?? SharedChoiceKind.Keep)
            : SharedChoiceKind.Keep;
        return (
          <Box key={change.seq} role="group" aria-label={paths}>
            <Stack gap={4}>
              <Text size="sm" ff="monospace" style={{ overflowWrap: 'anywhere' }}>
                {paths}
              </Text>
              {change.laterPages.length === 0 ? null : (
                <Text size="xs" c="dimmed">
                  {laterLine(change.laterPages)}
                </Text>
              )}
              <Group gap="sm" wrap="wrap">
                <SegmentedControl
                  size="xs"
                  value={choice}
                  disabled={disabled}
                  onChange={(value) => {
                    onChoose(
                      change.seq,
                      value === SharedChoiceKind.Drop
                        ? SharedChoiceKind.Drop
                        : SharedChoiceKind.Keep,
                    );
                  }}
                  data={[
                    { value: SharedChoiceKind.Keep, label: 'Keep' },
                    {
                      value: SharedChoiceKind.Drop,
                      label: 'Drop',
                      disabled: change.dropRefusal !== null,
                    },
                  ]}
                />
                {change.dropRefusal === null ? null : (
                  <Text size="xs" c="dimmed">
                    {`Only Keep: ${change.dropRefusal}`}
                  </Text>
                )}
              </Group>
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}
