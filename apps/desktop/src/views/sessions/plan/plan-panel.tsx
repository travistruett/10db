import {
  TaskStatus,
  type ShapeId,
  type ShapeProposalDto,
  type ShapeViewDto,
} from '@10db/contracts';
import { ActionIcon, Menu, Modal, Text } from '@mantine/core';
import { IconArrowBackUp, IconBooks, IconDots, IconFileExport } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTasks } from '../../../daemon/queries';
import { useShapeView } from '../../../daemon/shape-queries';
import { ExportButton } from './record/export-button';
import { ProposedPane } from './proposed-pane';
import { RoundAnnouncer } from './round-announcer';
import { UndoAcceptModal } from './undo-modals';

export interface PlanPanelProps {
  /** The session's plan; null in a New Plan tab before its first message makes the session. */
  readonly shapeId: ShapeId | null;
  /** Closes the panel; absent when the drawer around it has its own close. */
  readonly onClose?: () => void;
  /** Why?: the session scrolls to the messages a row came from and marks them. */
  readonly onWhy: (row: ShapeProposalDto) => void;
}

/** The session's Plan: its rows beside the conversation, with Accept, and Record and Export in ⋯. */
export function PlanPanel({ shapeId, onClose, onWhy }: PlanPanelProps) {
  const query = useShapeView(shapeId);
  const error = query.isError ? query.error.message : null;
  return (
    <>
      <ProposedPane
        view={query.data}
        loading={shapeId !== null && query.isLoading}
        error={error}
        summaryHere
        onWhy={onWhy}
        {...(onClose === undefined ? {} : { onClose })}
        menu={query.data === undefined ? null : <PlanMenu view={query.data} />}
      />
      <RoundAnnouncer view={query.data} />
    </>
  );
}

function PlanMenu({ view }: { readonly view: ShapeViewDto }) {
  const shapeId = view.shape.id;
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const accept = view.lastAccept;
  // Whether a task of the Accept has a run, from the tasks the Board reads. The daemon refuses on its own,
  // so this is only the hint that disables the item.
  const tasks = useTasks(view.shape.projectId).data;
  const started =
    accept === null
      ? undefined
      : (tasks ?? []).find(
          (t) =>
            accept.taskIds.includes(t.id) &&
            t.status !== TaskStatus.Cancelled &&
            t.workstreamId !== null,
        );
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon variant="subtle" aria-label="More Plan actions">
            <IconDots size={16} stroke={1.5} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconBooks size={14} stroke={1.5} />}
            onClick={() => {
              void navigate({ to: '/sessions/record/$shapeId', params: { shapeId } });
            }}
          >
            Record
          </Menu.Item>
          <Menu.Item
            leftSection={<IconFileExport size={14} stroke={1.5} />}
            onClick={() => {
              setExporting(true);
            }}
          >
            Export as Markdown…
          </Menu.Item>
          {accept === null ? null : (
            <Menu.Item
              leftSection={<IconArrowBackUp size={14} stroke={1.5} />}
              disabled={started !== undefined}
              onClick={() => {
                setUndoing(true);
              }}
            >
              Undo Accept
              {started === undefined ? null : (
                <Text size="xs" c="dimmed">
                  {`${started.title} has started; cancel its run and remove it from the Board first`}
                </Text>
              )}
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
      <UndoAcceptModal
        shapeId={shapeId}
        accept={undoing ? accept : null}
        onClose={() => {
          setUndoing(false);
        }}
      />
      <Modal
        opened={exporting}
        onClose={() => {
          setExporting(false);
        }}
        title="Export Plan"
        size="sm"
      >
        <ExportButton shapeId={shapeId} />
      </Modal>
    </>
  );
}
