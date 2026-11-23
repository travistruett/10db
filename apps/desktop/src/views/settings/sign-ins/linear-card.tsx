import { Alert, Skeleton } from '@mantine/core';
import { IconListDetails } from '@tabler/icons-react';
import { useProjects } from '../../../daemon/queries';
import { useLinearSignIns } from '../../../daemon/sign-in-queries';
import { IntegrationCard, StateText } from './integration-card';
import { LinearProjectRow, ProjectRows } from './project-rows';

/** Settings › Integrations › Linear: one row per project with its Report To Linear switch. */
export function LinearCard() {
  const linear = useLinearSignIns();
  const projects = useProjects();
  if (linear.isPending) return <Skeleton height={90} radius="md" />;
  const rows = linear.data?.rows ?? [];
  const list = projects.data ?? [];
  return (
    <IntegrationCard
      mark={<IconListDetails size={20} stroke={1.5} aria-hidden />}
      name="Linear"
      focusName="linear"
      help="Sign in inside Claude Code (/mcp, or the claude.ai Linear connector) or in Codex (Settings › Trust)."
    >
      {linear.isError ? (
        <Alert color="red" title="Couldn't read the Linear sign-ins">
          {linear.error.message}
        </Alert>
      ) : (
        <StateText>Signs in through Claude Code or Codex.</StateText>
      )}
      {list.length === 0 ? null : (
        <ProjectRows>
          {list.map((project) => (
            <LinearProjectRow
              key={project.id}
              project={project}
              row={rows.find((r) => r.accountId === project.accountId)}
            />
          ))}
        </ProjectRows>
      )}
    </IntegrationCard>
  );
}
