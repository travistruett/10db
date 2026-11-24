import type { ProjectDto } from '@10db/contracts';
import { Modal, ScrollArea } from '@mantine/core';
import { WorkbenchSetup } from './workbench-setup';

/**
 * The setup's suggestions over the screen that asked for them, so Cancel or Apply leaves the builder
 * where they were. Its ticks start afresh at each opening.
 */
export function WorkbenchSetupModal({
  project,
  opened,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Suggestions for ${project.name}`}
      size="xl"
      // What opened it (a menu item) may be gone; the opener puts focus back itself.
      returnFocus={false}
      scrollAreaComponent={ScrollArea.Autosize}
    >
      {opened ? <WorkbenchSetup project={project} onCancel={onClose} onApplied={onClose} /> : null}
    </Modal>
  );
}
