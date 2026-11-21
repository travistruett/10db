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

/** A row's attachments: by its key or a goal's task keys, or by the goal or tasks Convert made of it. */
export function attachmentsOf(
  row: ShapeProposalDto,
  all: readonly ShapeAttachmentDto[],
): ShapeAttachmentDto[] {
  const keys = new Set<string>([row.key]);
  if (row.kind === 'goal') for (const task of row.body.tasks) keys.add(task.key);
  const goalId = row.converted?.goalId ?? null;
  const taskIds = new Set<string>(row.converted?.taskIds ?? []);
  return all.filter(
    (a) =>
      keys.has(a.key) ||
      (goalId !== null && a.goalId === goalId) ||
      (a.taskId !== null && taskIds.has(a.taskId)),
  );
}

export function RowAttachments({
  row,
  title,
}: {
  readonly row: ShapeProposalDto;
  readonly title: string;
}) {
  const { shapeId, attachments, onAskForChanges } = use(AttachmentsContext);
  const mine = attachmentsOf(row, attachments);
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
