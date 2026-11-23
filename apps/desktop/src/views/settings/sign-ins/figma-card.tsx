import { Alert, Skeleton } from '@mantine/core';
import { IconBrandFigma } from '@tabler/icons-react';
import { useProjects } from '../../../daemon/queries';
import { useFigmaSignIns } from '../../../daemon/sign-in-queries';
import { IntegrationCard, StateText } from './integration-card';
import { FigmaProjectRow, ProjectRows } from './project-rows';

/** Settings › Integrations › Figma: one row per project, Connect Figma where its account can't reach Figma yet. */
export function FigmaCard() {
  const figma = useFigmaSignIns();
  const projects = useProjects();
  if (figma.isPending) return <Skeleton height={90} radius="md" />;
  const rows = figma.data?.rows ?? [];
  const list = projects.data ?? [];
  return (
    <IntegrationCard
      mark={<IconBrandFigma size={20} stroke={1.5} aria-hidden />}
      name="Figma"
      focusName="figma"
      help="A mock-up in a Plan opens in Figma and comes back as a new version. Connect Figma sets up Figma's server for the project's account. On Codex it signs in in your browser; on Claude Code you finish with /mcp. A Claude Code account that already has Figma through its plugin or the claude.ai connector shows as connected."
    >
      {figma.isError ? (
        <Alert color="red" title="Couldn't read the Figma sign-ins">
          {figma.error.message}
        </Alert>
      ) : (
        <StateText>Signs in through Claude Code or Codex. A mock-up can open in Figma.</StateText>
      )}
      {list.length === 0 ? null : (
        <ProjectRows>
          {list.map((project) => (
            <FigmaProjectRow
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
