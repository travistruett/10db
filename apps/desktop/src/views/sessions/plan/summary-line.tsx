import { Anchor, Group, Text } from '@mantine/core';
import { summaryParts, type ProposedGroups, type SectionKey } from './proposed-groups';

export interface SummaryLineProps {
  readonly groups: ProposedGroups;
  readonly onJump: (section: SectionKey) => void;
}

/**
 * Under the Proposed header, always on screen: "1 goal · 3 loose · 2 to record". Each count jumps
 * to its section. It is kept outside the scrolling list, so it stays pinned.
 */
export function SummaryLine({ groups, onJump }: SummaryLineProps) {
  const parts = summaryParts(groups);
  if (parts.length === 0) return null;
  return (
    <Group role="group" aria-label="Summary" gap={6} wrap="wrap">
      {parts.map((part, index) => (
        <Group key={part.text} gap={6} wrap="nowrap">
          {index === 0 ? null : (
            <Text span size="sm" c="dimmed" aria-hidden="true">
              {' · '}
            </Text>
          )}
          <Anchor
            component="button"
            type="button"
            size="sm"
            c="dimmed"
            onClick={() => {
              onJump(part.section);
            }}
          >
            {part.text}
          </Anchor>
        </Group>
      ))}
    </Group>
  );
}
