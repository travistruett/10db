import type { FigmaSignInRowDto, ProjectDto } from '@10db/contracts';
import { Alert, Skeleton, Text } from '@mantine/core';
import { IconVectorBezier2 } from '@tabler/icons-react';
import { useProjects } from '../../../daemon/queries';
import { useFigmaSignIns } from '../../../daemon/sign-in-queries';
import { IntegrationCard, StateText } from './integration-card';
import { ProjectRow, ProjectRows } from './project-rows';

/** What a project's account has with Figma, in the daemon's words. */
function figmaWords(row: FigmaSignInRowDto | undefined): string {
  return row?.note ?? 'Checked when the agent first uses Figma';
}

/** Settings › Integrations › Figma: how each project's account reaches Figma, and where to sign in. */
export function FigmaCard() {
  const figma = useFigmaSignIns();
  const projects = useProjects();
  if (figma.isPending) return <Skeleton height={90} radius="md" />;
  const rows = figma.data?.rows ?? [];
  const list: readonly ProjectDto[] = projects.data ?? [];
  return (
    <IntegrationCard
      mark={<IconVectorBezier2 size={20} stroke={1.5} aria-hidden />}
      name="Figma"
      focusName="figma"
    >
      {figma.isError ? (
        <Alert color="red" title="Couldn't read the Figma sign-ins">
          {figma.error.message}
        </Alert>
      ) : (
        <StateText>
          Sign in inside Claude Code (/mcp, or the Figma plugin) or in Codex (Settings › Trust). A
          mock-up in a Plan then opens in Figma and comes back as a new version.
        </StateText>
      )}
      {list.length === 0 ? null : (
        <ProjectRows>
          {list.map((project) => (
            <ProjectRow
              key={project.id}
              name={project.name}
              control={
                <Text size="sm" c="dimmed" ta="right" maw={420}>
                  {figmaWords(rows.find((r) => r.accountId === project.accountId))}
                </Text>
              }
            />
          ))}
        </ProjectRows>
      )}
    </IntegrationCard>
  );
}
