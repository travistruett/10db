import { EmptyState } from '@mantine/core';
import type { SettingsSection } from './sections';

/** A section whose editor a later plan builds; it says what it will hold and which plan fills it. */
export function PlannedSection({ section }: { readonly section: SettingsSection }) {
  return <EmptyState title="Not built yet" description={section.planned} />;
}
