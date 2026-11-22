import type { ProjectId } from '@10db/contracts';
import { Menu } from '@mantine/core';
import { useImportFromLinear, useProjectIntegrations } from '../../daemon/sign-in-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { useOpenSession } from './open-session';

function Item({ projectId }: { readonly projectId: ProjectId }) {
  const integrations = useProjectIntegrations(projectId);
  const start = useImportFromLinear(projectId);
  const open = useOpenSession();
  if (integrations.data?.linear.binding == null) return null;
  return (
    <Menu.Item
      disabled={start.isPending}
      onClick={() => {
        void start.mutateAsync().then((chat) => open(chat.id));
      }}
    >
      From Linear
    </Menu.Item>
  );
}

/** From Linear, beside New Plan: shown for a project linked to a Linear team; opens a Plan session that imports its issues. */
export function FromLinearItem() {
  const { project } = useSelectedProject();
  return project === null ? null : <Item projectId={project.id} />;
}
