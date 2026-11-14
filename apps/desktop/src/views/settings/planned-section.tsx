import { Text } from '@mantine/core';
import type { SettingsSection } from './sections';

/** What a built section still lacks, as a short note under its content. */
export function PlannedRemainder({ section }: { readonly section: SettingsSection }) {
  return (
    <Text size="sm" c="dimmed">
      {section.planned}
    </Text>
  );
}
