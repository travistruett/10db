import { Text } from '@mantine/core';
import type { ReactNode } from 'react';

/** Under the title of a section that exists at both scopes: which one this is, and how the other relates. */
export function ScopeLine({ children }: { readonly children: ReactNode }) {
  return (
    <Text size="sm" c="dimmed">
      {children}
    </Text>
  );
}
