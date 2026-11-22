import { Anchor, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { summaryParts, type ProposedGroups, type SectionKey } from './proposed-groups';

export interface SummaryLineProps {
  readonly groups: ProposedGroups;
  readonly onJump: (section: SectionKey) => void;
  /** What comes before the counts: "Round 2". */
  readonly lead?: string | null;
  /** What comes after them: when the round landed. */
  readonly tail?: string | null;
  /** A last link on the line, such as the round's changes. */
  readonly link?: ReactNode;
}

/**
 * The head's one dim line, always on screen: "Round 2 · 1 goal · 2 tasks · 1 to record · updated just
 * now · 4 changed this round". Each count jumps to its section. It is kept outside the scrolling list, so it stays pinned.
 */
export function SummaryLine({
  groups,
  onJump,
  lead = null,
  tail = null,
  link = null,
}: SummaryLineProps) {
  const items: ReactNode[] = [
    ...(lead === null ? [] : [<span key="lead">{lead}</span>]),
    ...summaryParts(groups).map((part) => (
      <Anchor
        key={part.text}
        component="button"
        type="button"
        fz={12}
        c="dimmed"
        onClick={() => {
          onJump(part.section);
        }}
      >
        {part.text}
      </Anchor>
    )),
    ...(tail === null ? [] : [<span key="tail">{tail}</span>]),
    ...(link === null ? [] : [<span key="link">{link}</span>]),
  ];
  if (items.length === 0) return null;
  return (
    <Text component="div" role="group" aria-label="Summary" fz={12} c="dimmed">
      {items.flatMap((item, index) => [
        ...(index === 0 ? [] : [' · ']),
        <span key={`item-${String(index)}`}>{item}</span>,
      ])}
    </Text>
  );
}
