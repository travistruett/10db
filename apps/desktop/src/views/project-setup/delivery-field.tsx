import { Delivery, type FolderInspection } from '@10db/contracts';
import { Box, Group, Radio, Select, Stack, Text } from '@mantine/core';
import { MONO_INPUT } from './folder-field';

const PULL_REQUEST_LINE =
  '10db works on a separate branch and opens a pull request on GitHub for you to review and merge.';
const LOCAL_LINE =
  '10db commits straight to the branch checked out in this folder. Nothing goes to GitHub.';

function ChoiceCard({
  value,
  title,
  line,
  disabled = false,
}: {
  readonly value: Delivery;
  readonly title: string;
  readonly line: string;
  readonly disabled?: boolean;
}) {
  return (
    <Radio.Card value={value} p="md" radius="md" disabled={disabled}>
      <Group wrap="nowrap" align="flex-start">
        <Radio.Indicator disabled={disabled} />
        <Box>
          <Text fw={500}>{title}</Text>
          <Text size="sm" c="dimmed">
            {line}
          </Text>
        </Box>
      </Group>
    </Radio.Card>
  );
}

export interface DeliveryFieldProps {
  readonly delivery: Delivery;
  readonly onDelivery: (delivery: Delivery) => void;
  /** Why pull requests can't be chosen; shown as that card's line. */
  readonly pullRequestBlock: string | null;
  readonly branches: FolderInspection['branches'];
  readonly baseBranch: string;
  readonly onBaseBranch: (branch: string) => void;
}

/** How finished work leaves the project, and under pull requests the branch they start from. */
export function DeliveryField({
  delivery,
  onDelivery,
  pullRequestBlock,
  branches,
  baseBranch,
  onBaseBranch,
}: DeliveryFieldProps) {
  return (
    <Stack gap="lg">
      <Radio.Group
        label="When work is finished"
        value={delivery}
        onChange={(value) => {
          onDelivery(value === Delivery.PullRequest ? Delivery.PullRequest : Delivery.Local);
        }}
      >
        <Stack mt="xs" gap="xs">
          <ChoiceCard
            value={Delivery.PullRequest}
            title="Open a pull request"
            line={pullRequestBlock ?? PULL_REQUEST_LINE}
            disabled={pullRequestBlock !== null}
          />
          <ChoiceCard value={Delivery.Local} title="Commit directly" line={LOCAL_LINE} />
        </Stack>
      </Radio.Group>
      {delivery === Delivery.PullRequest ? (
        <Select
          label="Base branch"
          description="Pull requests start from and merge into this branch."
          searchable
          required
          allowDeselect={false}
          data={branches.map((b) => b.name)}
          value={baseBranch === '' ? null : baseBranch}
          styles={MONO_INPUT}
          onChange={(value) => {
            onBaseBranch(value ?? '');
          }}
        />
      ) : null}
    </Stack>
  );
}
