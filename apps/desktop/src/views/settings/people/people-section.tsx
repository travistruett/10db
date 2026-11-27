import type { PersonDto } from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Button,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconBrandSlack,
  IconPencil,
  IconTrash,
  IconUserPlus,
  IconUsers,
} from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { PageLoading, PageLoadingShape } from '../../../shell/page-loading';
import { EmptyState } from '../../../shell/empty-state';
import { useState } from 'react';
import { usePeople, useRemovePerson, useSlackMember, useSlackStatus } from '../../../daemon/people';
import { SettingsSectionKey } from '../sections';
import { PersonAnswers } from './person-answers';
import { PersonModal } from './person-modal';
import { StakeholderTimers } from './stakeholder-timers';
import { RaisedPanel } from '../../../shell/raised-panel';

/** The table's column titles, which its placeholder draws too while the people load. */
const PEOPLE_COLUMNS = {
  name: { title: 'Name' },
  howSent: { title: "How It's Sent" },
  answers: { title: 'Answers' },
  actions: { title: '' },
} as const;

/** The table's scroll width, kept by its placeholder. */
const PEOPLE_MIN_WIDTH = 640;

/** The builder's person is named "You" until they pick their Slack member. */
function rowName(person: PersonDto): string {
  if (!person.isBuilder || person.name === 'You') return person.name;
  return `You · ${person.name}`;
}

/** The mode every contact shares, or "By Workspace" when they differ. */
function howSent(person: PersonDto): string {
  if (person.isBuilder) return '—';
  const modes = new Set(person.slack.map((c) => c.sendMode));
  if (modes.size === 0) return 'You pass it on';
  if (modes.size > 1) return 'By Workspace';
  return modes.has('auto') ? 'Sent on Its Own' : 'Shown to You First';
}

/** One workspace the person is reachable in: the Slack mark, the workspace and their name there. */
function WorkspaceChip({
  teamId,
  userId,
  teamName,
}: {
  readonly teamId: string;
  readonly userId: string;
  readonly teamName: string;
}) {
  const member = useSlackMember(teamId, userId);
  return (
    <Badge
      variant="default"
      size="sm"
      tt="none"
      fw={500}
      leftSection={<IconBrandSlack size={12} stroke={1.5} aria-hidden />}
    >
      {member === null ? teamName : `${teamName} @${member.name}`}
    </Badge>
  );
}

/** How 10db reaches someone: a chip per signed-in workspace they are in ("Acme @mark"), or "Not on Slack". */
function ReachChip({ person }: { readonly person: PersonDto }) {
  const status = useSlackStatus();
  const signedIn = status.data?.workspaces ?? [];
  const contacts = person.slack.flatMap((c) => {
    const workspace = signedIn.find((w) => w.teamId === c.teamId);
    return workspace === undefined ? [] : [{ contact: c, teamName: workspace.teamName }];
  });
  if (contacts.length === 0)
    return person.isBuilder ? null : (
      <Badge variant="default" size="sm" tt="none" fw={500}>
        Not on Slack
      </Badge>
    );
  return (
    <>
      {contacts.map(({ contact, teamName }) => (
        <WorkspaceChip
          key={contact.teamId}
          teamId={contact.teamId}
          userId={contact.userId}
          teamName={teamName}
        />
      ))}
    </>
  );
}

/** While no workspace is connected, Slack can't carry questions: a callout with the one button that fixes it. */
function ConnectSlack() {
  const status = useSlackStatus().data;
  const navigate = useNavigate();
  if (status === undefined || status.workspaces.some((w) => w.state === 'connected')) return null;
  if (status.workspaces.some((w) => w.state === 'unreachable' || w.state === 'checking'))
    return null;
  return (
    <Alert
      variant="light"
      color="yellow"
      icon={<IconBrandSlack size={18} stroke={1.5} />}
      title="Slack isn't connected"
    >
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">
          Until it is, 10db can't message anyone; you pass each question on yourself.
        </Text>
        <Button
          size="xs"
          variant="default"
          style={{ flex: 'none' }}
          onClick={() => {
            void navigate({
              to: '/settings/$section',
              params: { section: SettingsSectionKey.Integrations },
              search: { focus: 'slack' },
            });
          }}
        >
          Connect Slack
        </Button>
      </Group>
    </Alert>
  );
}

/** A person's initials in a circle; the builder's is the primary color. */
function Initials({ person }: { readonly person: PersonDto }) {
  const letters = person.name
    .split(/\s+/)
    .map((word) => word[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <Avatar size={28} radius="xl" color={person.isBuilder ? 'primary' : 'gray'} aria-hidden>
      {letters}
    </Avatar>
  );
}

/** Settings › People: who answers questions, how 10db reaches each one, and when it stops waiting. */
export function PeopleSection() {
  const people = usePeople();
  const remove = useRemovePerson();
  // `undefined` is closed, `null` is a new person.
  const [editing, setEditing] = useState<PersonDto | null | undefined>(undefined);
  const [removing, setRemoving] = useState<PersonDto | null>(null);
  const rows = [...(people.data ?? [])].sort((a, b) => Number(b.isBuilder) - Number(a.isBuilder));
  // While only the builder is listed the empty state holds Add Person, so the page has one.
  const onlyYou = people.isSuccess && rows.every((p) => p.isBuilder);

  return (
    <Stack gap="xl">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-end" wrap="nowrap">
          <Text c="dimmed" size="sm">
            Who answers your projects' questions, and how 10db reaches each one.
          </Text>
          {onlyYou ? null : (
            <Button
              onClick={() => {
                setEditing(null);
              }}
            >
              Add Person
            </Button>
          )}
        </Group>
        <ConnectSlack />
        {people.isPending ? (
          <PageLoading
            shape={PageLoadingShape.Table}
            label="Loading people"
            columns={Object.values(PEOPLE_COLUMNS)}
            minWidth={PEOPLE_MIN_WIDTH}
            rows={3}
            cellLines={2}
            verticalSpacing="sm"
            horizontalSpacing="md"
          />
        ) : null}
        {people.isError ? (
          <Alert color="red" title="Couldn't load people">
            {people.error.message}
          </Alert>
        ) : null}
        {people.isSuccess ? (
          <RaisedPanel>
            <Table.ScrollContainer minWidth={PEOPLE_MIN_WIDTH}>
              <Table verticalSpacing="sm" horizontalSpacing="md">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{PEOPLE_COLUMNS.name.title}</Table.Th>
                    <Table.Th>{PEOPLE_COLUMNS.howSent.title}</Table.Th>
                    <Table.Th>{PEOPLE_COLUMNS.answers.title}</Table.Th>
                    <Table.Th aria-label="Actions" />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((person) => (
                    <Table.Tr key={person.id}>
                      <Table.Td>
                        <Group gap="sm" wrap="nowrap">
                          <Initials person={person} />
                          <Stack gap={4} align="flex-start">
                            <Text size="sm" fw={500} style={{ whiteSpace: 'nowrap' }}>
                              {rowName(person)}
                            </Text>
                            <Group gap={4} wrap="nowrap">
                              <ReachChip person={person} />
                            </Group>
                          </Stack>
                        </Group>
                      </Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{howSent(person)}</Table.Td>
                      <Table.Td>
                        <PersonAnswers person={person} />
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          <Tooltip label="Edit" withArrow>
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              aria-label={`Edit ${person.name}`}
                              onClick={() => {
                                setEditing(person);
                              }}
                            >
                              <IconPencil size={16} stroke={1.5} />
                            </ActionIcon>
                          </Tooltip>
                          {person.isBuilder ? null : (
                            <Tooltip label="Remove" withArrow>
                              <ActionIcon
                                variant="subtle"
                                color="red"
                                aria-label={`Remove ${person.name}`}
                                loading={remove.isPending && remove.variables === person.id}
                                onClick={() => {
                                  setRemoving(person);
                                }}
                              >
                                <IconTrash size={16} stroke={1.5} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </RaisedPanel>
        ) : null}
        {onlyYou ? (
          <EmptyState
            icon={IconUsers}
            title="Only you answer questions"
            action={{
              label: 'Add Person',
              icon: IconUserPlus,
              onClick: () => {
                setEditing(null);
              },
            }}
          >
            Add a teammate, and 10db can route a project&apos;s product, design or legal questions
            to them.
          </EmptyState>
        ) : null}
      </Stack>
      {remove.isError ? (
        <Alert color="red" variant="light">
          {remove.error.message}
        </Alert>
      ) : null}
      <Modal
        opened={removing !== null}
        onClose={() => {
          setRemoving(null);
        }}
        title={`Remove ${removing?.name ?? ''}?`}
      >
        <Stack gap="md">
          <Text size="sm">
            Their Slack contact is deleted. Questions already sent to them stay in the Waiting tab.
          </Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setRemoving(null);
              }}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={() => {
                if (removing) remove.mutate(removing.id);
                setRemoving(null);
              }}
            >
              Remove Person
            </Button>
          </Group>
        </Stack>
      </Modal>
      <StakeholderTimers />
      <PersonModal
        person={editing ?? null}
        people={people.data ?? []}
        opened={editing !== undefined}
        onClose={() => {
          setEditing(undefined);
        }}
      />
    </Stack>
  );
}
