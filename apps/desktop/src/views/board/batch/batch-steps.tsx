import { ROLE_LABEL, type StepPlanDto } from '@10db/contracts';
import { Badge, Table, Text } from '@mantine/core';

/** Spec §5.2.4: each step's persona, model@effort and why. */
export function BatchSteps({
  title,
  plan,
}: {
  readonly title: string;
  readonly plan: StepPlanDto;
}) {
  return (
    <Table verticalSpacing={4} fz="sm" aria-label={`Steps for ${title}`}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Step</Table.Th>
          <Table.Th>Persona</Table.Th>
          <Table.Th>Profile</Table.Th>
          <Table.Th>Why</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {plan.steps.map((step, i) => (
          <Table.Tr key={`${String(i)}-${step.role}`}>
            <Table.Td>{ROLE_LABEL[step.role]}</Table.Td>
            <Table.Td>{step.personaName}</Table.Td>
            <Table.Td>
              <Text size="sm" ff="monospace">{`${step.model}@${step.effort}`}</Text>
              {plan.overBudget.includes(i) ? (
                <Badge size="xs" color="red" variant="light">
                  Over budget
                </Badge>
              ) : null}
            </Table.Td>
            <Table.Td>
              <Text size="xs" c="dimmed">
                {step.reason}
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
