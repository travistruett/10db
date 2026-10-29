import type { ProjectDto } from '@10db/contracts';
import { Button } from '@mantine/core';
import { useProjectSetup } from '../views/project-setup/project-setup';
import { FormModal } from './form-modal';

/** The New Project modal; mounted only while open, so each project starts from an empty form. */
export function NewProjectModal({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: (project: ProjectDto) => void;
}) {
  const setup = useProjectSetup(onCreated);
  return (
    <FormModal
      opened
      onClose={onClose}
      title="New Project"
      error={setup.error}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!setup.canSubmit} loading={setup.pending} onClick={setup.submit}>
            Create Project
          </Button>
        </>
      }
    >
      {setup.fields}
    </FormModal>
  );
}
