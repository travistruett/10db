import type { ProjectDto } from '@10db/contracts';
import { Code, Stack, Table, Text } from '@mantine/core';

const NOTE = 'Editing areas comes later; create a new project to change them.';

/** The project's areas and hazards, read-only: no route patches them yet. Paths and globs render as text. */
export function ProjectAreas({ project }: { readonly project: ProjectDto }) {
  return (
    <Stack>
      <Table>
        <Table.Caption>{`Areas. ${NOTE}`}</Table.Caption>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Globs</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {project.areas.map((area) => (
            <Table.Tr key={area.name}>
              <Table.Td>{area.name}</Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  {area.globs.map((glob) => (
                    <Code key={glob}>{glob}</Code>
                  ))}
                </Stack>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {project.hazards.length === 0 ? (
        <Text c="dimmed">No hazards.</Text>
      ) : (
        <Table>
          <Table.Caption>{`Hazards. ${NOTE}`}</Table.Caption>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Globs</Table.Th>
              <Table.Th>Commands</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {project.hazards.map((hazard) => (
              <Table.Tr key={hazard.name}>
                <Table.Td>{hazard.name}</Table.Td>
                <Table.Td>
                  <Stack gap={2}>
                    {hazard.globs.map((glob) => (
                      <Code key={glob}>{glob}</Code>
                    ))}
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <Stack gap={2}>
                    {hazard.commands.map((command) => (
                      <Code key={command}>{command}</Code>
                    ))}
                  </Stack>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
