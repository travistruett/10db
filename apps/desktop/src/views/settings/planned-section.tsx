import { EmptyState, Text } from '@mantine/core';
import type { SettingsSection } from './sections';

/** A section with nothing built yet; it says what it will hold and which plan fills it. */
export function PlannedSection({ section }: { readonly section: SettingsSection }) {
  return <EmptyState title="Not built yet" description={section.planned} />;
}

/** What a built section still lacks, as a short note under its content. */
export function PlannedRemainder({ section }: { readonly section: SettingsSection }) {
  return (
    <Text size="sm" c="dimmed">
      Still to come: {section.planned}
    </Text>
  );
}
