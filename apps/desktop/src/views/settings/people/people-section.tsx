import type { PersonDto } from '@10db/contracts';
import { Alert, Button, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { usePeople, useRemovePerson } from '../../../daemon/people';
import { PersonModal } from './person-modal';
import { SlackConnection } from './slack-connection';
import { StakeholderTimers } from './stakeholder-timers';

function sends(person: PersonDto): string {
  if (person.slack === null) return '—';
  return person.slack.sendMode === 'auto' ? 'Send Without Asking' : 'Review Each';
}

/** Settings › People: who answers besides the builder, and how 10db reaches them. */
export function PeopleSection() {
  const people = usePeople();
  const remove = useRemovePerson();
  // `undefined` is closed, `null` is a new person.
  const [editing, setEditing] = useState<PersonDto | null | undefined>(undefined);

  return (
    <Stack>
      <Group justify="space-between">
        <Text c="dimmed" size="sm">
          Who answers questions besides you, and how 10db reaches them.
        </Text>
        <Button
          onClick={() => {
            setEditing(null);
          }}
        >
          Add Person
        </Button>
      </Group>
      <SlackConnection />
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
              <Table.Th>Slack</Table.Th>
              <Table.Th>Sends</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {people.data.map((person) => (
              <Table.Tr key={person.id}>
                <Table.Td>{person.name}</Table.Td>
                <Table.Td>
                  {person.isBuilder
                    ? '—'
                    : person.slack === null
                      ? 'not in Slack'
                      : `@${person.handle}`}
                </Table.Td>
                <Table.Td>{sends(person)}</Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end">
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
        opened={editing !== undefined}
        onClose={() => {
          setEditing(undefined);
        }}
      />
    </Stack>
  );
}
