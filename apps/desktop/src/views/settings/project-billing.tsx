import { BillingMode, type ProjectDto } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';

const BILLING_LABELS: Readonly<Record<BillingMode, string>> = {
  [BillingMode.Subscription]: 'Subscription',
  [BillingMode.ApiKey]: 'API key',
  [BillingMode.Bedrock]: 'Bedrock',
};

/** How the project pays for sessions, read-only until accounts replace billing modes. */
export function ProjectBilling({ project }: { readonly project: ProjectDto }) {
  return (
    <Stack gap="xs">
      <Text>{BILLING_LABELS[project.billingMode]}</Text>
      <Text size="sm" c="dimmed">{`Default model: ${project.model}@${project.effort}`}</Text>
      <Text size="sm" c="dimmed">
        Accounts replace billing modes: this is where the project&apos;s account picker goes, filled
        by the accounts plan.
      </Text>
    </Stack>
  );
}
