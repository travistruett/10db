import type { ShapeId, ShapeProposalDto } from '@10db/contracts';
import { ActionIcon, Menu, Modal } from '@mantine/core';
import { IconBooks, IconDots, IconFileExport } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useShapeView } from '../../../daemon/shape-queries';
import { ExportButton } from '../../shape/record/export-button';
import { ProposedPane } from './proposed-pane';
import { RoundAnnouncer } from './round-announcer';

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
        menu={shapeId === null ? null : <PlanMenu shapeId={shapeId} />}
      />
      <RoundAnnouncer view={query.data} />
    </>
  );
}

function PlanMenu({ shapeId }: { readonly shapeId: ShapeId }) {
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);
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
              void navigate({ to: '/shape/$shapeId/record', params: { shapeId } });
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
        </Menu.Dropdown>
      </Menu>
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
