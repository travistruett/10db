import { Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';

// Sessions UI spec §11, design spec S8: Plan's header says when its agent runs none of Plan's research
// and review agents (`capabilities.subagents` false, as on Codex).

export function AgentsLine({ subagents }: { readonly subagents: boolean }) {
  if (subagents) return null;
  return (
    <Text size="xs" c="dimmed" px="md" style={{ flex: 'none' }}>
      <IconInfoCircle size={14} stroke={1.5} aria-hidden="true" style={{ verticalAlign: '-2px' }} />{' '}
      Research and review agents need a Claude account. This conversation runs without them.
    </Text>
  );
}
