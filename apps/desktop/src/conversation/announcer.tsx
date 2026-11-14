import { VisuallyHidden } from '@mantine/core';

/**
 * A screen's one polite live region: a new message replaces the last. The screen mounts it once and says
 * what changed; it never moves focus.
 */
export function Announcer({
  message,
  label = 'Announcements',
}: {
  readonly message: string | null;
  readonly label?: string;
}) {
  return (
    <VisuallyHidden role="status" aria-live="polite" aria-label={label}>
      {message ?? ''}
    </VisuallyHidden>
  );
}
