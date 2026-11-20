import type { ShapeAttachmentDto, ShapeProposalDto } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import { createContext, use } from 'react';
import { AttachmentView } from './attachment-view';

// Shape spec §10.3: an opened row shows what the session attached to it, each rendered inert. The
// sidebar provides the view's attachments once, so the rows between don't pass them along.

export const AttachmentsContext = createContext<readonly ShapeAttachmentDto[]>([]);

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
  const mine = attachmentsOf(row, use(AttachmentsContext));
  if (mine.length === 0) return null;
  return (
    <Stack gap="xs" pt="xs">
      {mine.map((a) => (
        <Stack key={a.id} gap={4}>
          <Text size="xs" c="dimmed">
            {KIND_LABEL[a.attachment.kind]}
          </Text>
          <AttachmentView attachment={a.attachment} title={title} />
        </Stack>
      ))}
    </Stack>
  );
}
