import { JudgeKind } from '@10db/contracts';
import { Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';

// Sessions UI spec §11: how a session's calls are judged. Only the rules floor is said, since an
// agent's own judge and 10db's show themselves in the rows and cards they raise.

export function JudgeLine({ judge }: { readonly judge: JudgeKind }) {
  switch (judge) {
    case JudgeKind.Native:
    case JudgeKind.Tendb:
      return null;
    case JudgeKind.Rules:
      return (
        <Text size="xs" c="dimmed" px="md" style={{ flex: 'none' }}>
          <IconInfoCircle
            size={14}
            stroke={1.5}
            aria-hidden="true"
            style={{ verticalAlign: '-2px' }}
          />{' '}
          Judged by 10db’s rules. Pick an account in Settings › Decisions for 10db’s judge.
        </Text>
      );
  }
}
