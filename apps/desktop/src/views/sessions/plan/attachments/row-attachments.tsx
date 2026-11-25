import type { ShapeAttachmentDto, ShapeId, ShapeProposalDto } from '@10db/contracts';
import { Anchor, Button, Loader, Group, Menu, Stack, Text } from '@mantine/core';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import { createContext, use, useState } from 'react';
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

/**
 * A row's attachments. Each one's versions show as one: the newest with its label, its view and, under a
 * mock-up, Approve, Ask for Changes and Figma; the older ones fold behind Earlier Versions, so a mock-up
 * brought back from Figma a few times doesn't stack copies with the same buttons down the row.
 */
export function RowAttachments({
  row,
  title,
  task,
}: {
  readonly row: ShapeProposalDto;
  readonly title: string;
  readonly task?: GoalTaskRef;
}) {
  const { shapeId, attachments } = use(AttachmentsContext);
  const mine = attachmentsOf(row, attachments, task);
  if (mine.length === 0 || shapeId === null) return null;
  return (
    <Stack gap={10}>
      {versionsOf(mine).map((versions) => (
        <AttachmentVersions
          key={versions[0]?.id}
          row={row}
          shapeId={shapeId}
          versions={versions}
          title={title}
        />
      ))}
    </Stack>
  );
}

/** Attachments grouped by kind and key, oldest first, each group where its first version stood. */
function versionsOf(list: readonly ShapeAttachmentDto[]): ShapeAttachmentDto[][] {
  const groups = new Map<string, ShapeAttachmentDto[]>();
  for (const a of list) {
    const id = `${a.attachment.kind}:${a.key}`;
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [a]);
    else group.push(a);
  }
  return [...groups.values()];
}

function AttachmentVersions({
  row,
  shapeId,
  versions,
  title,
}: {
  readonly row: ShapeProposalDto;
  readonly shapeId: ShapeId;
  readonly versions: readonly ShapeAttachmentDto[];
  readonly title: string;
}) {
  const [earlierOpen, setEarlierOpen] = useState(false);
  const newest = versions.at(-1);
  if (newest === undefined) return null;
  const earlier = versions.slice(0, -1).reverse();
  const approvedEarlier = earlier.find((a) => a.approved);
  const numbered = versions.length > 1;
  // A goal's own mock-up is the goal's picture, not a design target: it has no actions.
  const actionable = (a: ShapeAttachmentDto): boolean =>
    a.attachment.kind === 'mockup' &&
    a.goalId === null &&
    !(row.kind === 'goal' && a.key === row.key);
  return (
    <Stack gap={4}>
      <VersionLabel
        attachment={newest}
        label={`${KIND_LABEL[newest.attachment.kind]}${numbered ? ` · Version ${String(versions.length)}` : ''}`}
      />
      <AttachmentView attachment={newest.attachment} title={title} />
      {actionable(newest) ? (
        <MockupActions shapeId={shapeId} attachment={newest} title={title} />
      ) : null}
      {earlier.length > 0 ? (
        <Group gap={8} mt={6}>
          <Anchor
            component="button"
            type="button"
            fz={12}
            c="dimmed"
            aria-expanded={earlierOpen}
            onClick={() => {
              setEarlierOpen((open) => !open);
            }}
          >
            {earlierOpen ? 'Hide Earlier Versions' : `Earlier Versions (${String(earlier.length)})`}
          </Anchor>
          {/* The approved version is the design target the task gets, so say so while it is folded away. */}
          {approvedEarlier !== undefined && !earlierOpen ? (
            <ApprovedMark
              text={`Version ${String(versions.indexOf(approvedEarlier) + 1)} Approved`}
            />
          ) : null}
        </Group>
      ) : null}
      {earlierOpen
        ? earlier.map((a) => (
            <Stack key={a.id} gap={4} mt={6}>
              <VersionLabel attachment={a} label={`Version ${String(versions.indexOf(a) + 1)}`} />
              <AttachmentView attachment={a.attachment} title={title} />
              {a.approved && actionable(a) ? (
                <Group>
                  <ApproveButton shapeId={shapeId} attachment={a} title={title} />
                </Group>
              ) : null}
            </Stack>
          ))
        : null}
    </Stack>
  );
}

function VersionLabel({
  attachment,
  label,
}: {
  readonly attachment: ShapeAttachmentDto;
  readonly label: string;
}) {
  return (
    <Group gap={8} wrap="nowrap">
      <Text fz={12} fw={600} c="dimmed">
        {label}
      </Text>
      {attachment.approved ? <ApprovedMark text="Approved" /> : null}
    </Group>
  );
}

function ApprovedMark({ text }: { readonly text: string }) {
  return (
    <Text fz={12} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <IconCheck
        size={14}
        stroke={2}
        color="var(--mantine-color-green-filled)"
        aria-hidden="true"
      />
      {text}
    </Text>
  );
}

/** Under the newest mock-up: Approve, Ask for Changes and Figma, or the quiet undo once approved. */
function MockupActions({
  shapeId,
  attachment,
  title,
}: {
  readonly shapeId: ShapeId;
  readonly attachment: ShapeAttachmentDto;
  readonly title: string;
}) {
  const { onAskForChanges } = use(AttachmentsContext);
  return (
    <Group gap={8} mt={8}>
      {attachment.approved ? null : (
        <ApproveButton shapeId={shapeId} attachment={attachment} title={title} />
      )}
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
      <FigmaButtons shapeId={shapeId} attachment={attachment} title={title} />
      {/* Approved, the undo is a quiet link at the right: the state is what matters. */}
      {attachment.approved ? (
        <Group ml="auto">
          <ApproveButton shapeId={shapeId} attachment={attachment} title={title} />
        </Group>
      ) : null}
    </Group>
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
  const sendToNewFile = (): void => {
    press.mutate({ attachmentId: attachment.id, action: 'open', newFile: true });
  };
  const busy = press.data?.status === 'running' ? 'Another Figma request is still running.' : null;
  const message = press.isError ? press.error.message : open.isError ? open.error.message : busy;
  const error =
    message === null ? null : (
      <Text size="xs" c="red">
        {message}
      </Text>
    );
  const pending = attachment.figma?.pending ?? null;
  if (pending !== null)
    return (
      <Group gap={6} wrap="nowrap" role="status">
        <Loader size={12} />
        <Text size="xs" c="dimmed">
          {pending === 'open' ? 'Sending to Figma…' : 'Bringing back from Figma…'}
        </Text>
      </Group>
    );
  const linked = (attachment.figma?.fileUrl ?? null) !== null;
  // A project's first send is one plain button; once the project has a Figma file, every mock-up has one
  // Figma menu, which also offers a new file in case the stored one was lost.
  if (!linked && attachment.figma?.fileStored !== true)
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
          {linked ? (
            <>
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
            </>
          ) : (
            <Menu.Item onClick={send}>Open in Figma</Menu.Item>
          )}
          <Menu.Item onClick={sendToNewFile}>Send to a New Figma File</Menu.Item>
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
