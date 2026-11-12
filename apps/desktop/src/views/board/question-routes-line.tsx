import type { QuestionRouteDto, TaskDto } from '@10db/contracts';
import { Anchor, Group, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useQuestionRoutes } from '../../daemon/people';
import { SettingsSectionKey } from '../settings/sections';

const FROM_WORDS: Readonly<Record<QuestionRouteDto['from'], string>> = {
  task: 'this task',
  goal: 'the goal',
  area: 'the area',
  project: 'the project',
  topic: 'a topic',
};

interface Group_ {
  readonly people: string;
  readonly from: QuestionRouteDto['from'];
  readonly kinds: string[];
}

/** "Mark Ellis (product, design), from the goal": routes of one scope for the same people fold together. */
function groups(routes: readonly QuestionRouteDto[]): Group_[] {
  const found: Group_[] = [];
  for (const route of routes) {
    const people = route.people.map((p) => p.name).join(' and ');
    const kind = route.category ?? route.topic ?? '';
    const same = found.find((g) => g.people === people && g.from === route.from);
    if (same) same.kinds.push(kind);
    else found.push({ people, from: route.from, kinds: [kind] });
  }
  return found;
}

/** The task drawer's Overview line on who answers this task's questions, and the way to change it. */
export function QuestionRoutesLine({ task }: { readonly task: TaskDto }) {
  const routes = useQuestionRoutes(task.id);
  const found = groups(routes.data ?? []);
  if (found.length === 0) return null;
  const words = found
    .map((g) => `${g.people} (${g.kinds.join(', ')}), from ${FROM_WORDS[g.from]}`)
    .join('; ');
  return (
    <Group gap="xs">
      <Text size="sm">{`Questions go to ${words}`}</Text>
      <Anchor
        size="sm"
        renderRoot={(props) => (
          <Link
            {...props}
            to="/settings/$section"
            params={{ section: SettingsSectionKey.RoutingRules }}
          />
        )}
      >
        Change
      </Anchor>
    </Group>
  );
}
