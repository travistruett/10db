import type { ShapeAttachmentDto, ShapeId, ShapeProposalDto } from '@10db/contracts';
import { Anchor, Button, Group, Menu, Stack, Text } from '@mantine/core';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import { createContext, use } from 'react';
import {
  useApproveAttachment,
  useFigmaPress,
  useOpenFigmaFrame,
} from '../../../../daemon/shape-queries';
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

const KIND_LABEL = { mermaid: 'Diagram', chart: 'Chart', mockup: 'Mock-up' } as const;

/** One task of a goal, by its key in the goal's body. */
export interface GoalTaskRef {
  readonly key: string;
}

/**
 * A row's attachments: by its key or the goal or tasks Convert made of it. A goal's own are those of
 * the goal; with `task`, those of that one task of it. Convert keeps the key, so a goal's task is
 * matched by it and never by position: the tasks it made follow dependency order, not the goal's.
 */
export function attachmentsOf(
  row: ShapeProposalDto,
  all: readonly ShapeAttachmentDto[],
  task?: GoalTaskRef,
): ShapeAttachmentDto[] {
  if (task !== undefined) return all.filter((a) => a.key === task.key);
  const goalId = row.converted?.goalId ?? null;
  const taskIds = new Set<string>(row.converted?.taskIds ?? []);
  return all.filter(
    (a) =>
      a.key === row.key ||
      (goalId !== null && a.goalId === goalId) ||
      (row.kind !== 'goal' && a.taskId !== null && taskIds.has(a.taskId)),
  );
}

/** A row's attachments: a dim label, the attachment, and under a mock-up its Approve and Ask for Changes. */
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
    <Stack gap={10}>
      {mine.map((a) => (
        <Stack key={a.id} gap={4}>
          <Group gap={8} wrap="nowrap">
            <Text fz={12} fw={600} c="dimmed">
              {KIND_LABEL[a.attachment.kind]}
            </Text>
            {a.approved ? (
              <Text fz={12} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <IconCheck
                  size={14}
                  stroke={2}
                  color="var(--mantine-color-green-filled)"
                  aria-hidden="true"
                />
                Approved
              </Text>
            ) : null}
          </Group>
          <AttachmentView attachment={a.attachment} title={title} />
          {a.attachment.kind === 'mockup' &&
          a.goalId === null &&
          !(row.kind === 'goal' && a.key === row.key) ? (
            <Group gap={8} mt={8}>
              {a.approved ? null : <ApproveButton shapeId={shapeId} attachment={a} title={title} />}
              <Button
                variant="default"
                size="xs"
                aria-label={`Ask for changes to mock-up: ${title}`}
                onClick={() => {
                  onAskForChanges(`Change the mock-up for "${title}": `);
                }}
              >
                Ask for Changes
              </Button>
              <FigmaButtons shapeId={shapeId} attachment={a} title={title} />
              {/* Approved, the undo is a quiet link at the right: the state is what matters. */}
              {a.approved ? (
                <Group ml="auto">
                  <ApproveButton shapeId={shapeId} attachment={a} title={title} />
                </Group>
              ) : null}
            </Group>
          ) : null}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * A mock-up's trip to Figma: one button to send it, then once linked one menu, so the row stays one line. The
 * menu follows the frame link, brings the frame back as a new version, or sends the mock-up again.
 */
function FigmaButtons({
  shapeId,
  attachment,
  title,
}: {
  readonly shapeId: ShapeId;
  readonly attachment: ShapeAttachmentDto;
  readonly title: string;
}) {
  const press = useFigmaPress(shapeId);
  const open = useOpenFigmaFrame(shapeId);
  const send = (): void => {
    press.mutate({ attachmentId: attachment.id, action: 'open' });
  };
  const error = press.isError ? (
    <Text size="xs" c="red">
      {press.error.message}
    </Text>
  ) : null;
  if (attachment.figma === null)
    return (
      <>
        <Button
          variant="default"
          size="xs"
          loading={press.isPending}
          aria-label={`Open in Figma: ${title}`}
          onClick={send}
        >
          Open in Figma
        </Button>
        {error}
      </>
    );
  return (
    <>
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button
            variant="default"
            size="xs"
            loading={press.isPending}
            rightSection={<IconChevronDown size={14} stroke={1.5} aria-hidden="true" />}
            aria-label={`Figma actions for mock-up: ${title}`}
          >
            Figma
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            onClick={() => {
              open.mutate(attachment.id);
            }}
          >
            Open Frame in Figma
          </Menu.Item>
          <Menu.Item
            onClick={() => {
              press.mutate({ attachmentId: attachment.id, action: 'bring-back' });
            }}
          >
            Bring Back from Figma
          </Menu.Item>
          <Menu.Item onClick={send}>Send Again to Figma</Menu.Item>
        </Menu.Dropdown>
      </Menu>
      {error}
    </>
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
  if (attachment.approved)
    return (
      <Anchor
        component="button"
        type="button"
        fz={12}
        c="dimmed"
        aria-label={`Remove approval of mock-up: ${title}`}
        onClick={() => {
          approve.mutate({ attachmentId: attachment.id, approved: false });
        }}
      >
        Remove Approval
      </Anchor>
    );
  return (
    <Button
      variant="light"
      size="xs"
      loading={approve.isPending}
      aria-label={`Approve mock-up: ${title}`}
      onClick={() => {
        approve.mutate({ attachmentId: attachment.id, approved: true });
      }}
    >
      Approve
    </Button>
  );
}
