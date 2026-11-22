import { SessionStartKind, type SessionStartDto } from '@10db/contracts';
import { Button, Stack, Text } from '@mantine/core';
import { IconAlertCircle, IconFolder, IconGitCommit } from '@tabler/icons-react';

// Sessions UI spec §6.2: at most three lines built by rules from the project's state. A click puts the
// text in the composer and sends nothing. They are not nudges: no sparkles and no ×.

function StartIcon({ kind }: { readonly kind: SessionStartKind }) {
  switch (kind) {
    case SessionStartKind.FailedTask:
      return <IconAlertCircle size={14} stroke={1.5} aria-hidden="true" />;
    case SessionStartKind.BaseCommits:
      return <IconGitCommit size={14} stroke={1.5} aria-hidden="true" />;
    case SessionStartKind.RecentArea:
      return <IconFolder size={14} stroke={1.5} aria-hidden="true" />;
  }
}

export function StartFrom({
  starts,
  onPick,
}: {
  readonly starts: readonly SessionStartDto[];
  readonly onPick: (text: string) => void;
}) {
  if (starts.length === 0) return null;
  return (
    <Stack gap={4} component="section" aria-label="Start From">
      <Text size="xs" fw={600} c="dimmed">
        Start From
      </Text>
      {starts.map((start) => (
        <Button
          key={`${start.kind}:${start.text}`}
          variant="subtle"
          size="xs"
          justify="flex-start"
          leftSection={<StartIcon kind={start.kind} />}
          onClick={() => {
            onPick(start.text);
          }}
        >
          {start.text}
        </Button>
      ))}
    </Stack>
  );
}
