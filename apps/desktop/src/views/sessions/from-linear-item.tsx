import { LinearVia, type ProjectDto } from '@10db/contracts';
import { Menu } from '@mantine/core';
import { useImportFromLinear, useLinearSignIns } from '../../daemon/sign-in-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { useOpenSession } from './open-session';

function Item({ project }: { readonly project: ProjectDto }) {
  const signIns = useLinearSignIns();
  const start = useImportFromLinear(project.id);
  const open = useOpenSession();
  const row = signIns.data?.rows.find((r) => r.accountId === project.accountId);
  // Only a definite none stops the import; a maybe goes ahead.
  if (row?.via === LinearVia.None && !row.unchecked)
    return (
      <>
        <Menu.Item disabled>From Linear</Menu.Item>
        <Menu.Label>{row.note ?? "This project's account has no Linear sign-in."}</Menu.Label>
      </>
    );
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

/** From Linear, beside New Session: shown when the project's account reaches Linear or might; opens a Plan session that imports issues. */
export function FromLinearItem() {
  const { project } = useSelectedProject();
  return project === null ? null : <Item project={project} />;
}
