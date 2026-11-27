import type { ProjectDto } from '@10db/contracts';
import {
  Alert,
  ActionIcon,
  Button,
  Group,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconPencil, IconRoute, IconTrash, IconUsers } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { EmptyState } from '../../shell/empty-state';
import { useGoals } from '../../daemon/goal-queries';
import { useJudgeStatus } from '../../daemon/judge-queries';
import { usePeople, useRoutingRules, useSetRoutingRules } from '../../daemon/people';
import { useTasks } from '../../daemon/queries';
import { categoryWord } from '../inbox/route-line';
import { AddRouteModal } from './add-route-modal';
import { HelpHint } from './help-hint';
import { RouteScope, routeRows, ruleInputs, type RouteRow } from './route-rows';
import { SettingsSectionKey } from './sections';
import { RaisedPanel } from '../../shell/raised-panel';

/** Settings › Question Routing: who a question goes to, by scope, most specific first. */
export function WhoAnswersSection({ project }: { readonly project: ProjectDto }) {
  const rules = useRoutingRules(project.id);
  const people = usePeople();
  const goals = useGoals(project.id);
  const tasks = useTasks(project.id);
  const judge = useJudgeStatus();
  const save = useSetRoutingRules(project.id);
  const [adding, setAdding] = useState(false);
  // The row open in the modal to edit; adding opens it empty.
  const [editing, setEditing] = useState<RouteRow | null>(null);
  const rows = routeRows(rules.data ?? [], people.data ?? []);
  const judgeOn =
    judge.data !== undefined &&
    !judge.data.off &&
    judge.data.account?.secretState === 'set' &&
    judge.data.config.enabled;

  const subjectWords = (scope: RouteScope, subject: string): string => {
    if (scope === RouteScope.Task)
      return tasks.data?.find((t) => t.id === subject)?.title ?? 'A task';
    if (scope === RouteScope.Goal)
      return goals.data?.goals.find((g) => g.goal.id === subject)?.goal.title ?? 'A goal';
    return subject;
  };

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={2}>
          <Group gap={4}>
            <Title order={4}>Routes</Title>
            <HelpHint label="Routes">
              <Text size="sm" mb={4}>
                A question goes to the first route that matches, most specific first.
              </Text>
              <Text size="sm">
                {judgeOn
                  ? "When none does, Jev picks from the project's categories and topics. Anything left comes to you."
                  : "Without Jev, the lane's own category and topic decide. Anything left comes to you."}
              </Text>
            </HelpHint>
          </Group>
          <Text size="sm" c="dimmed">
            Who answers each kind of question; the rest come to you.
          </Text>
        </Stack>
        <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
          <Button
            variant="default"
            leftSection={<IconUsers size={16} />}
            renderRoot={(props) => (
              <Link
                {...props}
                to="/settings/$section"
                params={{ section: SettingsSectionKey.People }}
              />
            )}
          >
            Manage People
          </Button>
          <Button
            onClick={() => {
              setAdding(true);
            }}
          >
            Add Route
          </Button>
        </Group>
      </Group>
      {rules.isPending ? (
        <PageLoading
          shape={PageLoadingShape.Table}
          label="Loading the routes"
          headings={['Scope', 'For', 'Questions', 'Goes To', '']}
          rows={3}
          verticalSpacing="xs"
        />
      ) : null}
      {rules.isError ? (
        <Alert color="red" title="Couldn't load the routes">
          {rules.error.message}
        </Alert>
      ) : null}
      {rules.isSuccess && rows.length === 0 ? (
        <EmptyState
          icon={IconRoute}
          title="No Routes Yet"
          action={{
            label: 'Add Route',
            onClick: () => {
              setAdding(true);
            },
          }}
        >
          Every question comes to you until a route sends it to someone else.
        </EmptyState>
      ) : null}
      {rules.isSuccess && rows.length > 0 ? (
        <RaisedPanel>
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={100}>Scope</Table.Th>
                  <Table.Th>For</Table.Th>
                  <Table.Th>Questions</Table.Th>
                  <Table.Th>Goes To</Table.Th>
                  <Table.Th w={80} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr
                    key={row.key}
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      setEditing(row);
                    }}
                  >
                    <Table.Td>{row.scope}</Table.Td>
                    <Table.Td>{subjectWords(row.scope, row.subject)}</Table.Td>
                    <Table.Td>{row.categories.map(categoryWord).join(', ')}</Table.Td>
                    <Table.Td>{row.people.join(', ')}</Table.Td>
                    <Table.Td ta="right">
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Tooltip label="Edit route">
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            aria-label={`Edit route for ${row.people.join(', ')}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setEditing(row);
                            }}
                          >
                            <IconPencil size={14} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Remove route">
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            aria-label={`Remove route for ${row.people.join(', ')}`}
                            loading={save.isPending}
                            onClick={(event) => {
                              event.stopPropagation();
                              save.mutate({
                                rules: ruleInputs(
                                  rules.data.filter((r) => !row.ruleIds.includes(r.id)),
                                ),
                              });
                            }}
                          >
                            <IconTrash size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
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
          </Table.ScrollContainer>
        </RaisedPanel>
      ) : null}
      {save.isError ? (
        <Alert color="red" variant="light">
          {save.error.message}
        </Alert>
      ) : null}
      <AddRouteModal
        project={project}
        opened={adding || editing !== null}
        rules={rules.data ?? []}
        route={editing}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
      />
    </Stack>
  );
}
