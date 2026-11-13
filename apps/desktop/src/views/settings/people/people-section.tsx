import type { PersonDto } from '@10db/contracts';
import { Alert, Anchor, Badge, Button, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { IconBrandSlack } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  usePeople,
  useRemovePerson,
  useSlackConnection,
  useSlackMember,
} from '../../../daemon/people';
import { SettingsSectionKey } from '../sections';
import { PersonAnswers } from './person-answers';
import { PersonModal } from './person-modal';
import { StakeholderTimers } from './stakeholder-timers';

/** The builder's person is named "You" until they pick their Slack member. */
function rowName(person: PersonDto): string {
  if (!person.isBuilder || person.name === 'You') return person.name;
  return `You · ${person.name}`;
}

function howSent(person: PersonDto): string {
  if (person.isBuilder) return '—';
  if (person.slack === null) return 'You pass it on';
  return person.slack.sendMode === 'auto' ? 'Sent on its own' : 'Shown to you first';
}

/** How 10db reaches someone, as a small chip: "Slack @Mark Ellis", or "Not on Slack". */
function ReachChip({ person }: { readonly person: PersonDto }) {
  const member = useSlackMember(person.slack?.userId ?? null);
  if (person.slack === null)
    return person.isBuilder ? null : (
      <Badge variant="default" size="sm" tt="none" fw={500}>
        Not on Slack
      </Badge>
    );
  return (
    <Badge
      variant="default"
      size="sm"
      tt="none"
      fw={500}
      leftSection={<IconBrandSlack size={12} stroke={1.5} aria-hidden />}
    >
      {member === null ? 'Slack' : `Slack @${member.name}`}
    </Badge>
  );
}

/** Points at Settings › Integrations while Slack can't carry questions. */
function ConnectSlackLine({ builder }: { readonly builder: PersonDto | undefined }) {
  const state = useSlackConnection().data?.state;
  if (state === undefined || state === 'unreachable' || builder === undefined) return null;
  const unfinished = state === 'connected' && builder.slack === null;
  if (state === 'connected' && !unfinished) return null;
  return (
    <Text size="sm" c="dimmed">
      {unfinished
        ? "Slack's setup isn't finished, so 10db can't message anyone yet."
        : "Slack isn't connected, so 10db can't message anyone yet."}{' '}
      <Anchor
        size="sm"
        // Inside a line of text, so it is underlined rather than told apart by color alone.
        underline="always"
        renderRoot={(props) => (
          <Link
            {...props}
            to="/settings/$section"
            params={{ section: SettingsSectionKey.Integrations }}
          />
        )}
      >
        {unfinished ? 'Finish it in Integrations' : 'Connect it in Integrations'}
      </Anchor>
    </Text>
  );
}

/** Settings › People: who answers questions, how 10db reaches each one, and when it stops waiting. */
export function PeopleSection() {
  const people = usePeople();
  const remove = useRemovePerson();
  // `undefined` is closed, `null` is a new person.
  const [editing, setEditing] = useState<PersonDto | null | undefined>(undefined);
  const rows = [...(people.data ?? [])].sort((a, b) => Number(b.isBuilder) - Number(a.isBuilder));

  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Text c="dimmed" size="sm">
          The people who answer your projects' questions, and how 10db reaches each one.
        </Text>
        <ConnectSlackLine builder={rows.find((p) => p.isBuilder)} />
      </Stack>
      {people.isPending ? <Loader size="sm" /> : null}
      {people.isError ? (
        <Alert color="red" title="Couldn't load people">
          {people.error.message}
        </Alert>
      ) : null}
      {people.isSuccess ? (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>How it's sent</Table.Th>
              <Table.Th>Answers</Table.Th>
              <Table.Th>
                <Group justify="flex-end">
                  <Button
                    size="xs"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    Add Person
                  </Button>
                </Group>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((person) => (
              <Table.Tr key={person.id}>
                <Table.Td>
                  <Group gap="xs">
                    <Text size="sm">{rowName(person)}</Text>
                    <ReachChip person={person} />
                  </Group>
                </Table.Td>
                <Table.Td>{howSent(person)}</Table.Td>
                <Table.Td>
                  <PersonAnswers person={person} />
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end" wrap="nowrap">
                    <Button
                      size="xs"
                      variant="subtle"
                      aria-label={`Edit ${person.name}`}
                      onClick={() => {
                        setEditing(person);
                      }}
                    >
                      Edit
                    </Button>
                    {person.isBuilder ? null : (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        aria-label={`Remove ${person.name}`}
                        loading={remove.isPending && remove.variables === person.id}
                        onClick={() => {
                          remove.mutate(person.id);
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : null}
      {remove.isError ? (
        <Alert color="red" variant="light">
          {remove.error.message}
        </Alert>
      ) : null}
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
