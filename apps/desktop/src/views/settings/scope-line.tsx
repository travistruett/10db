import { Text } from '@mantine/core';

/** Under the title of a section that exists at both scopes: which one this is, and how the other relates. */
export function ScopeLine({ children }: { readonly children: string }) {
  return (
    <Text size="sm" c="dimmed">
      {children}
    </Text>
  );
}
