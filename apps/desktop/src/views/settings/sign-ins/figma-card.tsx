import { FigmaVia, type ProjectDto } from '@10db/contracts';
import { Alert, Skeleton, Text } from '@mantine/core';
import { IconBrandFigma } from '@tabler/icons-react';
import { useProjects } from '../../../daemon/queries';
import { useFigmaSignIns } from '../../../daemon/sign-in-queries';
import { IntegrationCard, StateText } from './integration-card';
import { ProjectRow, ProjectRows } from './project-rows';

/** Settings › Integrations › Figma: sign-in lives in the agent; only a project whose account has no way in gets a row. */
export function FigmaCard() {
  const figma = useFigmaSignIns();
  const projects = useProjects();
  if (figma.isPending) return <Skeleton height={90} radius="md" />;
  const rows = figma.data?.rows ?? [];
  const list: readonly ProjectDto[] = projects.data ?? [];
  const missing = list.flatMap((project) => {
    const row = rows.find((r) => r.accountId === project.accountId);
    return row?.via === FigmaVia.None && row.note !== null ? [{ project, note: row.note }] : [];
  });
  return (
    <IntegrationCard
      mark={<IconBrandFigma size={20} stroke={1.5} aria-hidden />}
      name="Figma"
      focusName="figma"
      help="A mock-up in a Plan opens in Figma and comes back as a new version."
    >
      {figma.isError ? (
        <Alert color="red" title="Couldn't read the Figma sign-ins">
          {figma.error.message}
        </Alert>
      ) : (
        <StateText>
          Access is managed by the Figma plugin in Claude Code (/mcp) or by Codex.
        </StateText>
      )}
      {missing.length === 0 ? null : (
        <ProjectRows>
          {missing.map(({ project, note }) => (
            <ProjectRow
              key={project.id}
              name={project.name}
              control={
                <Text size="sm" c="dimmed" ta="right" maw={420}>
                  {note}
                </Text>
              }
            />
          ))}
        </ProjectRows>
      )}
    </IntegrationCard>
  );
}
