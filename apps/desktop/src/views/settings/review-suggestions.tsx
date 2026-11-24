import type { ProjectDto } from '@10db/contracts';
import { Button } from '@mantine/core';
import { useState } from 'react';
import { useWorkbenchSetup } from '../../daemon/pass-queries';
import { CountBadge } from '../../shell/count-badge';
import { WorkbenchSetupModal } from '../workbench/setup/setup-modal';
import { setUpCount } from '../workbench/setup/setup-rules';

/**
 * The pages and settings 10db found in the repository, offered only while it found some: opens them in a
 * modal over Areas, badged with how many.
 */
export function ReviewSuggestions({ project }: { readonly project: ProjectDto }) {
  const [opened, setOpened] = useState(false);
  const setup = useWorkbenchSetup(project.id);
  const count = setup.data === undefined ? 0 : setUpCount(setup.data, project.leftOutPages);
  if (count === 0 && !opened) return null;
  return (
    <>
      <Button
        variant="default"
        rightSection={count === 0 ? null : <CountBadge count={count} />}
        onClick={() => {
          setOpened(true);
        }}
      >
        Review Suggestions
      </Button>
      <WorkbenchSetupModal
        project={project}
        opened={opened}
        onClose={() => {
          setOpened(false);
        }}
      />
    </>
  );
}
