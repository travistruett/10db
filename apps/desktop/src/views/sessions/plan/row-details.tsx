import type { ShapeProposalDto, ShapeTaskSizeDto } from '@10db/contracts';
import { Group, Stack, Text } from '@mantine/core';
import { IconClockExclamation } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { CodeSpans } from './record/code-spans';
import { sizeFacts } from './size-line';

// What an opened row says. Text is plain: nothing a model wrote is rendered as markup, though its backtick
// spans read as code. An opened row is one block with one left edge, in one order: the description, its
// acceptance criteria, one dim line of facts and links, the attachments, and last the review's notes, which
// are about the task rather than part of it. Everything in it is 13 px, its labels 12 px dim.

export function Labelled({
  label,
  children,
}: {
  readonly label: string;
  readonly children: string;
}) {
  return (
    <Stack gap={0}>
      <Text fz={12} c="dimmed">
        {label}
      </Text>
      <Text fz={13} style={{ whiteSpace: 'pre-wrap' }}>
        {children}
      </Text>
    </Stack>
  );
}

export function Items({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <Stack gap={6}>
      <Text fz={12} fw={600} c="dimmed">
        {label}
      </Text>
      {/* Each item its own bullet, so long ones don't run together. */}
      <Stack component="ul" gap={4} m={0} p={0} pl={16} style={{ listStyle: 'disc' }}>
        {items.map((item) => (
          <Text key={item} component="li" fz={13}>
            <CodeSpans text={item} />
          </Text>
        ))}
      </Stack>
    </Stack>
  );
}

export interface DetailBlockProps {
  readonly description?: string;
  readonly notes?: ReactNode;
  readonly criteria?: readonly string[];
  /** Labelled parts a kind has beyond these. */
  readonly more?: ReactNode;
  /** The facts of the dim line, such as "repo · ~0.5 h". */
  readonly facts?: readonly string[];
  /** The facts' icon: the actual ran outside the size by more than one bucket. */
  readonly flagged?: boolean;
  /** Links that end the dim line, such as Why?. */
  readonly links?: readonly ReactNode[] | undefined;
  readonly attachments?: ReactNode;
  /** The row's own controls, Edit and ⋯, at the right of the facts line. */
  readonly actions?: ReactNode;
}

/** The opened row's block, in its one order. */
export function DetailBlock({
  description = '',
  notes,
  criteria = [],
  more,
  facts = [],
  flagged = false,
  links = [],
  attachments,
  actions,
}: DetailBlockProps) {
  return (
    <Stack gap={16}>
      {description === '' ? null : (
        <Text fz={13} style={{ whiteSpace: 'pre-wrap' }}>
          <CodeSpans text={description} />
        </Text>
      )}
      <Items label="Acceptance Criteria" items={criteria} />
      {more}
      <Group gap={8} wrap="nowrap" align="center">
        <Text fz={12} c="dimmed" component="div" style={{ flex: 1, minWidth: 0 }}>
          {[
            ...(facts.length === 0
              ? []
              : [
                  <span key="facts">
                    {facts.join(' · ')}
                    {flagged ? (
                      <>
                        {' '}
                        <IconClockExclamation
                          size={14}
                          stroke={1.5}
                          role="img"
                          aria-label="Outside its size by more than one bucket"
                          style={{ verticalAlign: '-2px' }}
                        />
                      </>
                    ) : null}
                  </span>,
                ]),
            ...links,
          ].flatMap((part, index) => [
            ...(index === 0 ? [] : [<span key={`dot-${String(index)}`}>{' · '}</span>]),
            part,
          ])}
        </Text>
        {actions}
      </Group>
      {attachments}
      {notes}
    </Stack>
  );
}

/** A task's facts, once: "Area: repo · about 0.5 h of agent time", then what it depends on. */
export function taskFacts(
  areas: readonly string[],
  size: ShapeTaskSizeDto | undefined,
  dependsOn: readonly string[],
): string[] {
  return [
    sizeFacts(areas, size),
    ...(dependsOn.length === 0 ? [] : [`depends on ${dependsOn.join(', ')}`]),
  ];
}

export interface RowDetailsProps {
  readonly row: ShapeProposalDto;
  readonly sizes: readonly ShapeTaskSizeDto[];
  readonly notes?: ReactNode;
  readonly links?: readonly ReactNode[] | undefined;
  readonly attachments?: ReactNode;
  readonly actions?: ReactNode;
}

/** An opened row of a card: what its kind says, in the block's order. */
export function RowDetails({ row, sizes, notes, links, attachments, actions }: RowDetailsProps) {
  const block = { notes, links, attachments, actions };
  switch (row.kind) {
    case 'goal': {
      const off = sizes.filter((s) => s.missized).length;
      return (
        <DetailBlock
          {...block}
          criteria={row.body.criteria.map((c) => `${c.text} (${c.check})`)}
          facts={[
            row.body.ceremony === 'spec' ? 'Spec first' : 'Direct, no spec',
            ...(off === 0 ? [] : [`${String(off)} mis-sized`]),
          ]}
        />
      );
    }
    case 'task':
      return (
        <DetailBlock
          {...block}
          description={row.body.description}
          criteria={row.body.criteria}
          facts={taskFacts(row.body.areas, sizes[0], row.body.dependsOn)}
          flagged={sizes[0]?.missized === true}
        />
      );
    case 'decision':
      return (
        <DetailBlock
          {...block}
          more={
            <>
              <Labelled label="Question">{row.body.question}</Labelled>
              <Labelled label="Why">{row.body.rationale}</Labelled>
            </>
          }
        />
      );
    case 'principle':
      return (
        <DetailBlock {...block} more={<Labelled label="Why">{row.body.rationale}</Labelled>} />
      );
    case 'question':
      return <DetailBlock {...block} more={<Labelled label="Asked of">{row.body.for}</Labelled>} />;
    case 'landing':
      return (
        <DetailBlock {...block} more={<Items label="Lands together" items={row.body.keys} />} />
      );
    case 'change_task':
      return (
        <DetailBlock
          {...block}
          description={row.body.description ?? ''}
          criteria={row.body.acceptanceCriteria ?? []}
          facts={row.body.areas === undefined ? [] : [row.body.areas.join(', ')]}
        />
      );
    case 'remove_task':
      return <DetailBlock {...block} more={<Labelled label="Why">{row.body.why}</Labelled>} />;
  }
}
