import type { PersonDto, ProjectViewDto, RoutingRuleDto } from '@10db/contracts';
import { Badge, Group, Text, Tooltip } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useProjects } from '../../../daemon/queries';
import { useRoutingRulesOfProjects } from '../../../daemon/people';
import { categoryWord } from '../../inbox/route-line';
import { ProjectTile } from '../../../shell/project-tile';
import { useSelectedProject } from '../../../shell/selected-project';
import { SettingsSectionKey } from '../sections';

/** What a rule covers, in words: a kind of question, or a topic, and the scope it holds in. */
function scopeWords(rule: RoutingRuleDto): string {
  const what = rule.topic ?? (rule.category === null ? '' : categoryWord(rule.category));
  const scope =
    rule.taskId !== null
      ? 'a task'
      : rule.goalId !== null
        ? 'a goal'
        : rule.area !== null
          ? `area ${rule.area}`
          : rule.topic !== null
            ? 'topic'
            : '';
  return scope === '' ? what.toLowerCase() : `${what.toLowerCase()} (${scope})`;
}

interface Line {
  readonly project: ProjectViewDto;
  readonly words: string;
}

/**
 * The projects a person answers for, one chip each (the project's tile and name) that opens its Question Routing;
 * what they answer there is in the chip's tooltip, so a person routed in many projects stays one short row.
 */
export function PersonAnswers({ person }: { readonly person: PersonDto }) {
  const projects = useProjects().data ?? [];
  const rules = useRoutingRulesOfProjects(projects.map((p) => p.id));
  const { select } = useSelectedProject();
  if (person.isBuilder) return <Text size="sm">Everything not routed</Text>;
  const lines: Line[] = projects.flatMap((project, index) => {
    const mine = (rules[index]?.data ?? []).filter((r) => r.personId === person.id);
    return mine.length === 0 ? [] : [{ project, words: mine.map(scopeWords).join(', ') }];
  });
  if (lines.length === 0) return <Text size="sm">—</Text>;
  return (
    <Group gap={6}>
      {lines.map(({ project, words }) => (
        <Tooltip key={project.id} label={`${project.name}: ${words}`} withArrow>
          <Badge
            variant="default"
            size="md"
            tt="none"
            fw={500}
            leftSection={<ProjectTile name={project.name} size={14} />}
            aria-label={`${project.name}: ${words}. Open its Question Routing`}
            style={{ cursor: 'pointer' }}
            renderRoot={(props) => (
              <Link
                {...props}
                to="/settings/$section"
                params={{ section: SettingsSectionKey.RoutingRules }}
                onClick={() => {
                  select(project.id);
                }}
              />
            )}
          >
            {project.name}
          </Badge>
        </Tooltip>
      ))}
    </Group>
  );
}
