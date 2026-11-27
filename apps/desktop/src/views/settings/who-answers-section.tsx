import type { ProjectDto } from '@10db/contracts';
import { Alert, ActionIcon, Button, Group, Stack, Table, Text, Tooltip } from '@mantine/core';
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
import { SettingsPageHeader } from './settings-page';

/** The table's column titles and widths, which its placeholder draws too while the routes load. */
const ROUTE_COLUMNS = {
  scope: { title: 'Scope', width: 100 },
  subject: { title: 'For' },
  questions: { title: 'Questions' },
  goesTo: { title: 'Goes To' },
  actions: { title: '', width: 80 },
} as const;

/** The table's scroll width, kept by its placeholder. */
const ROUTES_MIN_WIDTH = 560;

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
      <SettingsPageHeader
        sectionKey={SettingsSectionKey.RoutingRules}
        project={project}
        actions={
          <>
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
            {/* While there are no routes, the empty state holds the add. */}
            {rules.isSuccess && rows.length > 0 ? (
              <Button
                onClick={() => {
                  setAdding(true);
                }}
              >
                Add Route
              </Button>
            ) : null}
          </>
        }
      />
      {rules.isPending ? (
        <PageLoading
          shape={PageLoadingShape.Table}
          label="Loading the routes"
          columns={Object.values(ROUTE_COLUMNS)}
          minWidth={ROUTES_MIN_WIDTH}
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
          <Table.ScrollContainer minWidth={ROUTES_MIN_WIDTH}>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={ROUTE_COLUMNS.scope.width}>{ROUTE_COLUMNS.scope.title}</Table.Th>
                  <Table.Th>{ROUTE_COLUMNS.subject.title}</Table.Th>
                  <Table.Th>
                    <Group gap={4} wrap="nowrap">
                      {ROUTE_COLUMNS.questions.title}
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
                  </Table.Th>
                  <Table.Th>{ROUTE_COLUMNS.goesTo.title}</Table.Th>
                  <Table.Th w={ROUTE_COLUMNS.actions.width} />
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
