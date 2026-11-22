import {
  TaskStatus,
  type ShapeId,
  type ShapeProposalDto,
  type ShapeViewDto,
} from '@10db/contracts';
import { ActionIcon, Menu, Modal, Stack, Text, Tooltip } from '@mantine/core';
import { IconArrowBackUp, IconArrowsMaximize, IconDots, IconFileExport } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTasks } from '../../../daemon/queries';
import { useShapeView } from '../../../daemon/shape-queries';
import { MenuHint } from './menu-hint';
import { ExportButton } from './record/export-button';
import { ProposedPane } from './proposed-pane';
import { RoundAnnouncer } from './round-announcer';
import { UndoAcceptModal } from './undo-modals';

export interface PlanPanelProps {
  /** The session's plan; null in a New Plan tab before its first message makes the session. */
  readonly shapeId: ShapeId | null;
  /** Why?: the session scrolls to the messages a row came from and marks them. */
  readonly onWhy: (row: ShapeProposalDto) => void;
  readonly onAskForChanges: (text: string) => void;
  /** The Plan page's own tab, whose page names it: no title and no way to open the page. */
  readonly full?: boolean;
}

/**
 * The session's Plan: its rows beside the conversation, with Accept, an expand button that opens the
 * Plan page (the same rows, then its record), and Export and Undo Accept in ⋯.
 */
export function PlanPanel({ shapeId, onWhy, onAskForChanges, full = false }: PlanPanelProps) {
  const query = useShapeView(shapeId);
  const navigate = useNavigate();
  const error = query.isError ? query.error.message : null;
  const view = query.data;
  return (
    <>
      <ProposedPane
        view={view}
        loading={shapeId !== null && query.isLoading}
        error={error}
        summaryHere
        titled={!full}
        onWhy={onWhy}
        onAskForChanges={onAskForChanges}
        menu={
          view === undefined ? null : (
            <>
              {full ? null : (
                <Tooltip label="Open the Plan full page, with its documents, decisions and reviews">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="input-xs"
                    aria-label="Open Plan Page"
                    onClick={() => {
                      void navigate({
                        to: '/sessions/record/$shapeId',
                        params: { shapeId: view.shape.id },
                      });
                    }}
                  >
                    <IconArrowsMaximize size={16} stroke={1.5} />
                  </ActionIcon>
                </Tooltip>
              )}
              <PlanMenu view={view} />
            </>
          )
        }
      />
      <RoundAnnouncer view={query.data} />
    </>
  );
}

function PlanMenu({ view }: { readonly view: ShapeViewDto }) {
  const shapeId = view.shape.id;
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
          <Tooltip label="Export and Undo Accept">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="input-xs"
              aria-label="More Plan actions"
            >
              <IconDots size={16} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconFileExport size={14} stroke={1.5} />}
            onClick={() => {
              setExporting(true);
            }}
          >
            Export Record to Folder
          </Menu.Item>
          {accept === null ? null : (
            <Menu.Item
              leftSection={<IconArrowBackUp size={14} stroke={1.5} />}
              disabled={started !== undefined}
              onClick={() => {
                setUndoing(true);
              }}
            >
              {started === undefined ? (
                'Undo Accept'
              ) : (
                <MenuHint hint={`${started.title} has started; cancel its run first`}>
                  Undo Accept
                </MenuHint>
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
        title="Export Record"
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">
            Saves this plan's documents, decisions, reviews and checks as Markdown files in a folder
            you choose.
          </Text>
          <ExportButton shapeId={shapeId} label="Choose Folder" />
        </Stack>
      </Modal>
    </>
  );
}
