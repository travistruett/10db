import type { ProjectDto } from '@10db/contracts';
import { Alert, ActionIcon, Button, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { useGoals } from '../../daemon/goal-queries';
import { useJudgeStatus } from '../../daemon/judge-queries';
import { usePeople, useRoutingRules, useSetRoutingRules } from '../../daemon/people';
import { useTasks } from '../../daemon/queries';
import { categoryWord } from '../inbox/route-line';
import { AddRouteModal } from './add-route-modal';
import { RouteScope, routeRows, ruleInputs } from './route-rows';

/** Settings › Who Answers: who a question goes to, by scope, most specific first. */
export function WhoAnswersSection({ project }: { readonly project: ProjectDto }) {
  const rules = useRoutingRules(project.id);
  const people = usePeople();
  const goals = useGoals(project.id);
  const tasks = useTasks(project.id);
  const judge = useJudgeStatus();
  const save = useSetRoutingRules(project.id);
  const [adding, setAdding] = useState(false);
  const rows = routeRows(rules.data ?? [], people.data ?? []);
  const judgeOn =
    judge.data !== undefined && !judge.data.off && judge.data.keySet && judge.data.config.enabled;

  const subjectWords = (scope: RouteScope, subject: string): string => {
    if (scope === RouteScope.Task)
      return tasks.data?.find((t) => t.id === subject)?.title ?? 'A task';
    if (scope === RouteScope.Goal)
      return goals.data?.goals.find((g) => g.goal.id === subject)?.goal.title ?? 'A goal';
    return subject;
  };

  return (
    <Stack>
      <Group justify="space-between" align="flex-start">
        <Stack gap={2}>
          <Text size="sm" c="dimmed">
            A question goes to the first route that matches, most specific first. When none does,{' '}
            {judgeOn
              ? "Jev picks from the project's categories and topics."
              : "the lane's own category and topic decide."}{' '}
            Anything left comes to you.
          </Text>
        </Stack>
        <Button
          onClick={() => {
            setAdding(true);
          }}
        >
          Add Route
        </Button>
      </Group>
      {rules.isPending ? <Loader size="sm" /> : null}
      {rules.isError ? (
        <Alert color="red" title="Couldn't load the routes">
          {rules.error.message}
        </Alert>
      ) : null}
      {rules.isSuccess && rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No routes yet, so every question comes to you. Add one here, or use Ask Someone on a
          question card.
        </Text>
      ) : null}
      {rules.isSuccess && rows.length > 0 ? (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Scope</Table.Th>
              <Table.Th>For</Table.Th>
              <Table.Th>Questions</Table.Th>
              <Table.Th>Goes to</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.key}>
                <Table.Td>{row.scope}</Table.Td>
                <Table.Td>{subjectWords(row.scope, row.subject)}</Table.Td>
                <Table.Td>{row.categories.map(categoryWord).join(', ')}</Table.Td>
                <Table.Td>{row.people.join(', ')}</Table.Td>
                <Table.Td>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`Remove route for ${row.people.join(', ')}`}
                    loading={save.isPending}
                    onClick={() => {
                      save.mutate({
                        rules: ruleInputs(rules.data.filter((r) => !row.ruleIds.includes(r.id))),
                      });
                    }}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
            <Table.Tr>
              <Table.Td />
              <Table.Td />
              <Table.Td c="dimmed">Everything not routed</Table.Td>
              <Table.Td c="dimmed">You</Table.Td>
              <Table.Td />
            </Table.Tr>
          </Table.Tbody>
        </Table>
      ) : null}
      {save.isError ? (
        <Alert color="red" variant="light">
          {save.error.message}
        </Alert>
      ) : null}
      <AddRouteModal
        project={project}
        opened={adding}
        rules={rules.data ?? []}
        onClose={() => {
          setAdding(false);
        }}
      />
    </Stack>
  );
}
