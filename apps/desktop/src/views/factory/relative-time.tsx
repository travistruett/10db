import { Text } from '@mantine/core';
import { absoluteTime, fromNow, useNow } from '../../shell/relative';

export function RelativeTime({ at }: { readonly at: string | null }) {
  const now = useNow();
  if (at === null) return <Text size="sm">—</Text>;
  return (
    <Text size="sm" component="time" dateTime={at} title={absoluteTime(at)}>
      {fromNow(at, now)}
    </Text>
  );
}
