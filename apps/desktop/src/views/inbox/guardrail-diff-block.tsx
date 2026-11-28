import { GUARDRAIL_DIFF_DETAIL, GuardrailDiffDetail, type InboxItemDto } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import { CommandBlock } from './command-block';

/** How many lines of a guardrail file's diff show before the block scrolls. */
const DIFF_BLOCK_LINES = 16;

/**
 * The diff a card for a lane's write to a guardrail file carries (`detail.guardrailDiff`), in a scrolling monospace
 * block under the card's body, as text only. Nothing when the card holds none.
 */
export function GuardrailDiffBlock({ detail }: { readonly detail: InboxItemDto['detail'] }) {
  const parsed = GuardrailDiffDetail.safeParse(detail?.[GUARDRAIL_DIFF_DETAIL]);
  if (!parsed.success) return null;
  const diff = parsed.data;
  if (diff.shown === 'none')
    return (
      <Text size="xs" c="dimmed">
        No diff to show: {diff.reason}
      </Text>
    );
  return (
    <Stack gap={4}>
      <CommandBlock command={diff.text} label="Diff" maxLines={DIFF_BLOCK_LINES} />
      {diff.cut ? (
        <Text size="xs" c="dimmed">
          Diff cut at {String(diff.lines)} lines
        </Text>
      ) : null}
    </Stack>
  );
}
