import type { ProjectDto } from '@10db/contracts';
import { Button } from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useArchiveProject } from '../../daemon/archive-queries';
import { ConfirmModal } from '../../shell/confirm-modal';
import { SettingRow, SettingsCard } from './setting-row';

/** Archive Project: hides the project everywhere and stops its activity; nothing is deleted. */
export function ProjectArchiveCard({ project }: { readonly project: ProjectDto }) {
  const [asking, setAsking] = useState(false);
  const archive = useArchiveProject(project.id);
  const navigate = useNavigate();
  const close = (): void => {
    setAsking(false);
    archive.reset();
  };
  return (
    <SettingsCard title="Archive Project">
      <SettingRow
        label="Archive Project"
        description="Hides this project everywhere and stops its activity. Nothing is deleted; restore it from Settings › Overview."
      >
        <Button
          variant="outline"
          color="red"
          onClick={() => {
            setAsking(true);
          }}
        >
          Archive
        </Button>
      </SettingRow>
      <ConfirmModal
        opened={asking}
        title="Archive Project"
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        error={archive.error?.message ?? null}
        onCancel={close}
        onConfirm={() => {
          archive.mutate(undefined, {
            onSuccess: () => {
              close();
              void navigate({ to: '/board' });
            },
          });
        }}
      >
        {`Archive ${project.name}? It leaves the switcher, the Inbox and every list, and 10db stops its activity. The repository, its branches and pull requests are not touched. You can restore it from Settings › Overview.`}
      </ConfirmModal>
    </SettingsCard>
  );
}
