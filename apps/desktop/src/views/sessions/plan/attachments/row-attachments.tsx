import type { ShapeAttachmentDto, ShapeId, ShapeProposalDto } from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { createContext, use } from 'react';
import { useApproveAttachment } from '../../../../daemon/shape-queries';
import { AttachmentView } from './attachment-view';

// Shape spec §10.3: an opened row shows what the session attached to it, each rendered inert. The
// sidebar provides the view's attachments once, so the rows between don't pass them along.

/** The plan's attachments, and the plan they belong to (an approval is written against it). */
export const AttachmentsContext = createContext<{
  readonly shapeId: ShapeId | null;
  readonly attachments: readonly ShapeAttachmentDto[];
  /** Puts words in the session's composer draft and focuses it; nothing is sent. */
  readonly onAskForChanges: (text: string) => void;
}>({
  shapeId: null,
  attachments: [],
  onAskForChanges: () => undefined,
});

const KIND_LABEL = { mermaid: 'Diagram', chart: 'Chart', mockup: 'Mockup' } as const;

/** One task of a goal: its key in the goal's body and its place in the goal's order. */
export interface GoalTaskRef {
  readonly key: string;
  readonly index: number;
}

/**
 * A row's attachments: by its key or the goal or tasks Convert made of it. A goal's own are those of
 * the goal; with `task`, those of that one task of it.
 */
export function attachmentsOf(
  row: ShapeProposalDto,
  all: readonly ShapeAttachmentDto[],
  task?: GoalTaskRef,
): ShapeAttachmentDto[] {
  if (task !== undefined) {
    const taskId = row.converted?.taskIds[task.index] ?? null;
    return all.filter((a) => a.key === task.key || (taskId !== null && a.taskId === taskId));
  }
  const goalId = row.converted?.goalId ?? null;
  const taskIds = new Set<string>(row.converted?.taskIds ?? []);
  return all.filter(
    (a) =>
      a.key === row.key ||
      (goalId !== null && a.goalId === goalId) ||
      (row.kind !== 'goal' && a.taskId !== null && taskIds.has(a.taskId)),
  );
}

/** What a row's mock-ups say at a glance: approved, waiting for approval, or none. */
export function mockupState(mine: readonly ShapeAttachmentDto[]): 'approved' | 'waiting' | null {
  const mockups = mine.filter((a) => a.attachment.kind === 'mockup');
  if (mockups.length === 0) return null;
  return mockups.some((a) => a.approved) ? 'approved' : 'waiting';
}

export function RowAttachments({
  row,
  title,
  task,
}: {
  readonly row: ShapeProposalDto;
  readonly title: string;
  readonly task?: GoalTaskRef;
}) {
  const { shapeId, attachments, onAskForChanges } = use(AttachmentsContext);
  const mine = attachmentsOf(row, attachments, task);
  if (mine.length === 0 || shapeId === null) return null;
  return (
    <Stack gap="xs" pt="xs">
      {mine.map((a) => (
        <Stack key={a.id} gap={4}>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {KIND_LABEL[a.attachment.kind]}
              {a.approved ? ' · approved' : ''}
            </Text>
            {a.attachment.kind === 'mockup' &&
            a.goalId === null &&
            !(row.kind === 'goal' && a.key === row.key) ? (
              <>
                <ApproveButton shapeId={shapeId} attachment={a} title={title} />
                <Button
                  variant="subtle"
                  size="compact-xs"
                  aria-label={`Ask for changes to mock-up: ${title}`}
                  onClick={() => {
                    onAskForChanges(`Change the mock-up for "${title}": `);
                  }}
                >
                  Ask for Changes
                </Button>
              </>
            ) : null}
          </Group>
          <AttachmentView attachment={a.attachment} title={title} />
        </Stack>
      ))}
    </Stack>
  );
}

/** Approves a mock-up as the design target, or takes the approval back. */
function ApproveButton({
  shapeId,
  attachment,
  title,
}: {
  readonly shapeId: ShapeId;
  readonly attachment: ShapeAttachmentDto;
  readonly title: string;
}) {
  const approve = useApproveAttachment(shapeId);
  const label = attachment.approved ? 'Unapprove' : 'Approve';
  return (
    <Button
      variant="subtle"
      size="compact-xs"
      loading={approve.isPending}
      aria-label={`${label} mock-up: ${title}`}
      onClick={() => {
        approve.mutate({ attachmentId: attachment.id, approved: !attachment.approved });
      }}
    >
      {label}
    </Button>
  );
}
